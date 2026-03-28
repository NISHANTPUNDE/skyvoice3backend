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
    userFfmpeg: ChildProcess;
    adminFfmpeg: ChildProcess;
    info: RecordingInfo;
    transports: RecordingTransports;
    sdpFiles: string[];
    userExited: boolean;
    adminExited: boolean;
    userFilepath: string;
    adminFilepath: string;
}

// Map: `${roomId}:${userId}` → ActiveRecording
const activeRecordings = new Map<string, ActiveRecording>();

const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');

function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

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

function spawnSingleStreamFfmpeg(
    sdpPath: string,
    outputPath: string,
    label: string,
): ChildProcess {
    const ffmpegArgs = [
        '-protocol_whitelist', 'file,crypto,udp,rtp',
        // Extreme low-latency probing: force FFmpeg to instantly accept the codec
        // This stops FFmpeg from waiting 5 seconds on short PTT speeches.
        '-analyzeduration', '100000', 
        '-probesize', '65536',
        '-fflags', '+genpts+discardcorrupt',
        '-i', sdpPath,

        // MP3 codec for universal mobile playback
        '-c:a', 'libmp3lame',
        '-b:a', '64k',
        '-f', 'mp3',
        '-y',
        outputPath,
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
    });

    ffmpeg.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        if (line.includes('error') || line.includes('Error') || line.includes('bind failed')) {
            console.error(`[FFmpeg/${label}] ${line.slice(0, 500)}`);
        }
    });

    ffmpeg.on('error', (err: Error) => {
        console.error(`[FFmpeg/${label}] Process error:`, err.message);
    });

    return ffmpeg;
}

// Background mix: combines user + admin audio into single MP3
function backgroundMix(userFile: string, adminFile: string, outputFile: string, label: string) {
    const userExists = fs.existsSync(userFile);
    const adminExists = fs.existsSync(adminFile);
    const userSize = userExists ? fs.statSync(userFile).size : 0;
    const adminSize = adminExists ? fs.statSync(adminFile).size : 0;

    // If only user audio exists, just rename it
    if (userSize > 0 && adminSize === 0) {
        try { fs.renameSync(userFile, outputFile); } catch { /* ok */ }
        try { fs.unlinkSync(adminFile); } catch { /* ok */ }
        console.log(`[Recording] Mix: user-only → ${path.basename(outputFile)}`);
        return;
    }

    // If only admin audio exists (shouldn't happen), rename it
    if (userSize === 0 && adminSize > 0) {
        try { fs.renameSync(adminFile, outputFile); } catch { /* ok */ }
        try { fs.unlinkSync(userFile); } catch { /* ok */ }
        console.log(`[Recording] Mix: admin-only → ${path.basename(outputFile)}`);
        return;
    }

    // If neither has data, nothing to do
    if (userSize === 0 && adminSize === 0) {
        try { fs.unlinkSync(userFile); } catch { /* ok */ }
        try { fs.unlinkSync(adminFile); } catch { /* ok */ }
        console.log(`[Recording] Mix: both empty, skipping`);
        return;
    }

    // Both have data — mix them in background
    console.log(`[Recording] Mix: merging user (${Math.round(userSize / 1024)}KB) + admin (${Math.round(adminSize / 1024)}KB) → ${path.basename(outputFile)}`);

    const mixArgs = [
        '-i', userFile,
        '-i', adminFile,
        '-filter_complex', 'amix=inputs=2:duration=first:dropout_transition=0',
        '-c:a', 'libmp3lame',
        '-b:a', '64k',
        '-f', 'mp3',
        '-y',
        outputFile,
    ];

    const mixProcess = spawn('ffmpeg', mixArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
    });

    mixProcess.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        if (line.includes('error') || line.includes('Error')) {
            console.error(`[FFmpeg/mix/${label}] ${line.slice(0, 500)}`);
        }
    });

    mixProcess.on('close', (code: number | null) => {
        // Clean up temp files
        try { fs.unlinkSync(userFile); } catch { /* ok */ }
        try { fs.unlinkSync(adminFile); } catch { /* ok */ }

        if (code === 0) {
            const stats = fs.statSync(outputFile);
            console.log(`[Recording] Mix complete: ${path.basename(outputFile)} (${Math.round(stats.size / 1024)}KB)`);
        } else {
            console.error(`[Recording] Mix failed with code ${code} for ${label}`);
            // If mix failed but user file was already deleted, try to recover
            // The individual files are gone so we can't recover — just log
        }
    });

    mixProcess.on('error', (err: Error) => {
        console.error(`[Recording] Mix process error for ${label}:`, err.message);
    });
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

    // Final mixed output filename
    const filename = `segment_${timestamp}.mp3`;
    const filepath = path.join(roomDir, filename);

    // Temp files for individual streams
    const userFilepath = path.join(roomDir, `_user_${timestamp}.mp3`);
    const adminFilepath = path.join(roomDir, `_admin_${timestamp}.mp3`);

    // Allocate free ports for FFmpeg to receive RTP
    const [userPort, adminPort] = await getFreePorts(2);
    console.log(`[Recording] Allocated FFmpeg ports: user=${userPort}, admin=${adminPort} for ${key}`);

    // Write SDP files
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

    // Start TWO separate FFmpeg processes — one per stream
    console.log(`[Recording] Starting dual FFmpeg for ${key}: ${filename}`);

    const userFfmpeg = spawnSingleStreamFfmpeg(userSdpPath, userFilepath, `user/${userId}`);
    const adminFfmpeg = spawnSingleStreamFfmpeg(adminSdpPath, adminFilepath, `admin/${userId}`);

    let userExited = false;
    let adminExited = false;

    userFfmpeg.on('close', () => {
        const rec = activeRecordings.get(key);
        if (rec) rec.userExited = true;
        try { fs.unlinkSync(userSdpPath); } catch { /* ok */ }
    });

    adminFfmpeg.on('close', () => {
        const rec = activeRecordings.get(key);
        if (rec) rec.adminExited = true;
        try { fs.unlinkSync(adminSdpPath); } catch { /* ok */ }
    });

    // Wait for FFmpeg to start and bind to their UDP ports
    await new Promise(resolve => setTimeout(resolve, 300));

    // NOW connect transports — RTP data flows to ready FFmpeg
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
        userFfmpeg,
        adminFfmpeg,
        info,
        transports,
        sdpFiles: [userSdpPath, adminSdpPath],
        userExited: false,
        adminExited: false,
        userFilepath,
        adminFilepath,
    });
}

async function stopFfmpeg(ffmpeg: ChildProcess, exited: boolean, label: string): Promise<void> {
    if (exited) return;

    try {
        if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
            ffmpeg.stdin.write('q');
            ffmpeg.stdin.end();
        }
    } catch {
        try { ffmpeg.kill('SIGTERM'); } catch { /* ok */ }
    }

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

export async function stopRecording(
    roomId: string,
    userId: string,
): Promise<RecordingInfo | null> {
    const key = `${roomId}:${userId}`;
    const recording = activeRecordings.get(key);
    if (!recording) return null;

    activeRecordings.delete(key);

    const { userFfmpeg, adminFfmpeg, info, transports, sdpFiles, userFilepath, adminFilepath } = recording;

    // Stop both FFmpeg processes in parallel
    await Promise.all([
        stopFfmpeg(userFfmpeg, recording.userExited, `user/${userId}`),
        stopFfmpeg(adminFfmpeg, recording.adminExited, `admin/${userId}`),
    ]);

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

    // Background mix: merge user + admin into final file
    // This runs asynchronously — doesn't block PTT release
    backgroundMix(userFilepath, adminFilepath, info.filepath, `${roomId}:${userId}`);

    console.log(`[Recording] Stopped: ${info.filename} (${Math.round((info.duration || 0) / 1000)}s) — mixing in background`);
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
            // Show final mixed files (segment_*) but not temp files (_user_*, _admin_*)
            .filter(f => (f.endsWith('.mp3') || f.endsWith('.webm')) && !f.startsWith('_'))
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
