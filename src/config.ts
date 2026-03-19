import dotenv from 'dotenv';
dotenv.config();

export const config = {
    port: parseInt(process.env.PORT || '3001', 10),
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/skyvoice2',
    jwtSecret: process.env.JWT_SECRET || 'skyvoice2-secret-key-change-in-production',

    // SuperAdmin seed credentials
    superAdminUsername: process.env.SUPER_ADMIN_USERNAME || 'superadmin',
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || 'admin123',

    // MediaSoup - Optimized for 50+ concurrent users
    mediasoup: {
        numWorkers: parseInt(process.env.MEDIASOUP_NUM_WORKERS || '4', 10), // Increase for more CPU cores
        worker: {
            rtcMinPort: 10000,
            rtcMaxPort: 10500,  // Increased range for 50+ users (500 ports)
            logLevel: 'warn' as const,
            logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'] as const,
        },
        router: {
            mediaCodecs: [
                {
                    kind: 'audio' as const,
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                },
            ],
        },
        webRtcTransport: {
            listenIps: [
                {
                    ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || undefined,
                },
            ],
            maxIncomingBitrate: 600000,   // Reduced for voice-only (600kbps)
            initialAvailableOutgoingBitrate: 600000,
            minimumAvailableOutgoingBitrate: 300000,
            maxSctpMessageSize: 262144,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            enableSctp: false,  // Disable SCTP (not needed for audio-only)
        },
        plainTransport: {
            listenIp: {
                ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || undefined,
            },
            maxSctpMessageSize: 262144,
            enableSctp: false,
            enableSrtp: false,
            enableRtx: false,
        }
    },
};
