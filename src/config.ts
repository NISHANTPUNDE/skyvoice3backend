import dotenv from 'dotenv';
dotenv.config();

export const config = {
    port: parseInt(process.env.PORT || '3001', 10),
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/skyvoice2',
    jwtSecret: process.env.JWT_SECRET || 'skyvoice2-secret-key-change-in-production',

    // SuperAdmin seed credentials
    superAdminEmail: process.env.SUPER_ADMIN_EMAIL || 'superadmin@skyvoice.com',
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || 'admin123',

    // MediaSoup
    mediasoup: {
        numWorkers: 1,
        worker: {
            rtcMinPort: 10000,
            rtcMaxPort: 10100,
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
            maxIncomingBitrate: 1500000,
            initialAvailableOutgoingBitrate: 1000000,
        },
    },
};
