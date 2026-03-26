import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as dgram from 'dgram';
import * as mediasoup from 'mediasoup';

export interface RecordingInfo {
    filename: string;
    filepath: string;
    userId: string;
    roomId: string;
    startTime: number;
    endTime?: number;
    duration?: number;
}

interface RecordingTransports {
    userTransport: mediasoup.types.PlainTransport;
    userConsumer: mediasoup.types.Consumer;
    adminTransport: mediasoup.types.PlainTransport;
    adminConsumer: mediasoup.types.Consumer;
}

interface ActiveRecording {
    ffmpeg: ChildProcess;
    info: RecordingInfo;
    transports: RecordingTransports;
    sdpFiles: string[];
    exited: boolean;
}

// Map: `${roomId}:${userId}` → ActiveRecording
const activeRecordings = new Map<string, ActiveRecording>();

const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');

// Ensure recordings directory exists
function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// Allocate free UDP ports for FFmpeg to listen on
async function getFreePorts(count: number): Promise<number[]> {
    const ports: number[] = [];
    const sockets: dgram.Socket[] = [];

    for (let i = 0; i < count; i++) {
        const sock = dgram.createSocket('udp4');
        await new Promise<void>((resolve, reject) => {
            sock.on('error', reject);
            sock.bind(0, '127.0.0.1', () => resolve());
        });
        const addr = sock.address();
        ports.push(typeof addr === 'string' ? 0 : addr.port);
        sockets.push(sock);
    }

    // Close all sockets to free the ports for FFmpeg
    for (const sock of sockets) {
        sock.close();
    }

    return ports;
}

function generateSdp(
    ffmpegPort: number,
    consumer: mediasoup.types.Consumer,
): string {
    const rtpParams = consumer.rtpParameters;
    const codec = rtpParams.codecs[0];
    const payloadType = codec.payloadType;
    const clockRate = codec.clockRate;

    return [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=MediaSoup RTP',
        'c=IN IP4 127.0.0.1',
        't=0 0',
        `m=audio ${ffmpegPort} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} opus/${clockRate}/2`,
        `a=fmtp:${payloadType} minptime=10;useinbandfec=1`,
        '',
    ].join('\r\n');
}

export async function startRecording(
    roomId: string,
    userId: string,
    transports: RecordingTransports,
): Promise<void> {
    const key = `${roomId}:${userId}`;

    // If already recording, stop old one first
    if (activeRecordings.has(key)) {
        await stopRecording(roomId, userId);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const roomDir = path.join(RECORDINGS_DIR, roomId, userId);
    ensureDir(roomDir);

    const filename = `segment_${timestamp}.mp3`;
    const filepath = path.join(roomDir, filename);

    // Allocate free ports for FFmpeg to receive RTP
    const [userPort, adminPort] = await getFreePorts(2);
    console.log(`[Recording] Allocated FFmpeg ports: user=${userPort}, admin=${adminPort} for ${key}`);

    // Step 1: Write SDP files FIRST (FFmpeg needs them to know which ports to bind)
    const userSdpPath = path.join(roomDir, `user_${timestamp}.sdp`);
    const adminSdpPath = path.join(roomDir, `admin_${timestamp}.sdp`);

    const userSdp = generateSdp(userPort, transports.userConsumer);
    const adminSdp = generateSdp(adminPort, transports.adminConsumer);

    fs.writeFileSync(userSdpPath, userSdp);
    fs.writeFileSync(adminSdpPath, adminSdp);

    const info: RecordingInfo = {
        filename,
        filepath,
        userId,
        roomId,
        startTime: Date.now(),
    };

    const protocolWhitelist = 'file,udp,rtp,pipe,crypto,data';

    // FFmpeg args — record only this user's audio plus the current admin audio
    const ffmpegArgs = [
        // Input 1: User audio
        '-protocol_whitelist', protocolWhitelist,
        '-analyzeduration', '5000000',
        '-probesize', '1000000',
        '-fflags', '+genpts+discardcorrupt',
        '-thread_queue_size', '512',
        '-i', userSdpPath,

        // Input 2: Admin audio
        '-protocol_whitelist', protocolWhitelist,
        '-analyzeduration', '5000000',
        '-probesize', '1000000',
        '-fflags', '+genpts+discardcorrupt',
        '-thread_queue_size', '512',
        '-i', adminSdpPath,

        // Mix exactly these 2 streams into a single recording
        '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[aout]',
        '-map', '[aout]',

        // MP3 codec for universal mobile playback compatibility
        '-c:a', 'libmp3lame',
        '-b:a', '64k',
        '-ar', '48000',
        '-ac', '2',

        // Container
        '-f', 'mp3',

        // Output
        '-y',
        filepath,
    ];

    console.log(`[Recording] Starting FFmpeg for ${key}: ${filename}`);

    // Step 2: Start FFmpeg FIRST — let it bind to the ports
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
    });

    // Log errors
    let errorBuffer = '';
    ffmpeg.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        if (line.includes('error') || line.includes('Error') || line.includes('bind failed')) {
            errorBuffer += line;
            if (errorBuffer.length > 2000) {
                console.error(`[FFmpeg/${userId}] ${errorBuffer.slice(0, 2000)}`);
                errorBuffer = '';
            }
        }
    });

    ffmpeg.on('close', (code: number | null) => {
        // Mark as exited so stopRecording doesn't wait forever
        const rec = activeRecordings.get(key);
        if (rec) rec.exited = true;

        if (code !== 0 && code !== null) {
            console.error(`[Recording] FFmpeg exited for ${key} with code ${code}`);
            if (errorBuffer) {
                console.error(`[FFmpeg/${userId}] Error: ${errorBuffer}`);
            }
        }
        // Clean up SDP files
        try { fs.unlinkSync(userSdpPath); } catch { /* ok */ }
        try { fs.unlinkSync(adminSdpPath); } catch { /* ok */ }
    });

    ffmpeg.on('error', (err: Error) => {
        console.error(`[Recording] FFmpeg error for ${key}:`, err.message);
    });

    // Step 3: Wait for FFmpeg to start and bind to the UDP ports
    await new Promise(resolve => setTimeout(resolve, 300));

    // Step 4: NOW connect transports — RTP data flows to ready FFmpeg
    try {
        await transports.userTransport.connect({ ip: '127.0.0.1', port: userPort });
    } catch (err) {
        console.error(`[Recording] Failed to connect user transport for ${key}:`, err);
    }

    try {
        await transports.adminTransport.connect({ ip: '127.0.0.1', port: adminPort });
    } catch (err) {
        console.error(`[Recording] Failed to connect admin transport for ${key}:`, err);
    }

    activeRecordings.set(key, {
        ffmpeg,
        info,
        transports,
        sdpFiles: [userSdpPath, adminSdpPath],
        exited: false,
    });
}

export async function stopRecording(
    roomId: string,
    userId: string,
): Promise<RecordingInfo | null> {
    const key = `${roomId}:${userId}`;
    const recording = activeRecordings.get(key);
    if (!recording) return null;

    activeRecordings.delete(key);

    const { ffmpeg, info, transports, sdpFiles } = recording;

    // Send 'q' to FFmpeg stdin to gracefully stop
    try {
        if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
            ffmpeg.stdin.write('q');
            ffmpeg.stdin.end();
        }
    } catch {
        // If stdin write fails, kill the process
        try { ffmpeg.kill('SIGTERM'); } catch { /* ok */ }
    }

    // Wait for FFmpeg to exit (max 5s)
    if (!recording.exited) {
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                try { ffmpeg.kill('SIGKILL'); } catch { /* ok */ }
                resolve();
            }, 5000);
            ffmpeg.on('close', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    // Close PlainTransports and consumers
    try { transports.userConsumer.close(); } catch { /* ok */ }
    try { transports.adminConsumer.close(); } catch { /* ok */ }
    try { transports.userTransport.close(); } catch { /* ok */ }
    try { transports.adminTransport.close(); } catch { /* ok */ }

    // Clean up SDP files
    for (const sdpFile of sdpFiles) {
        try { fs.unlinkSync(sdpFile); } catch { /* ok */ }
    }

    info.endTime = Date.now();
    info.duration = info.endTime - info.startTime;

    // Verify file was created — save ALL recordings regardless of size
    if (!fs.existsSync(info.filepath)) {
        console.warn(`[Recording] File not created: ${info.filepath}`);
        return null;
    }

    const stats = fs.statSync(info.filepath);
    console.log(`[Recording] Saved: ${info.filename} (${Math.round((info.duration || 0) / 1000)}s, ${Math.round(stats.size / 1024)}KB)`);
    return info;
}

export function getRecordingsForRoom(roomId: string): Record<string, RecordingInfo[]> {
    const roomDir = path.join(RECORDINGS_DIR, roomId);
    if (!fs.existsSync(roomDir)) return {};

    const result: Record<string, RecordingInfo[]> = {};
    const userDirs = fs.readdirSync(roomDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

    for (const dir of userDirs) {
        const userId = dir.name;
        const userDir = path.join(roomDir, userId);
        const files = fs.readdirSync(userDir)
            .filter(f => f.endsWith('.mp3'))
            .sort();

        result[userId] = files.map(filename => {
            const filepath = path.join(userDir, filename);
            const stats = fs.statSync(filepath);
            return {
                filename,
                filepath,
                userId,
                roomId,
                startTime: stats.mtimeMs,
                duration: undefined,
            };
        });
    }

    return result;
}

export function getRecordingFilePath(roomId: string, userId: string, filename: string): string | null {
    const filepath = path.join(RECORDINGS_DIR, roomId, userId, filename);
    if (fs.existsSync(filepath)) return filepath;
    return null;
}

export function getRecordingsDir(): string {
    return RECORDINGS_DIR;
}
