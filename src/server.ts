import express from 'express';
import http from 'http';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';

import { config } from './config';
import { SuperAdmin } from './models/SuperAdmin';
import { createWorkers } from './media/mediasoupManager';
import { setupWebSocket } from './ws/wsHandler';

import superadminRoutes from './routes/superadmin';
import adminRoutes from './routes/admin';
import userRoutes from './routes/user';
import recordingsRoutes from './routes/recordings';
import publicRoutes from './routes/public';

async function main() {
    // Connect to MongoDB
    try {
        await mongoose.connect(config.mongoUri);
        console.log('MongoDB connected');
    } catch (err) {
        console.error('MongoDB connection error:', err);
        process.exit(1);
    }

    // Seed SuperAdmin if not exists
    const existingSuperAdmin = await SuperAdmin.findOne({ username: config.superAdminUsername });
    if (!existingSuperAdmin) {
        const passwordHash = await bcrypt.hash(config.superAdminPassword, 10);
        await SuperAdmin.create({ username: config.superAdminUsername, passwordHash });
        console.log(`SuperAdmin seeded: ${config.superAdminUsername}`);
    }

    // Create mediasoup workers
    await createWorkers();

    // Ensure recordings directory exists
    const recordingsDir = path.resolve(process.cwd(), 'recordings');
    if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir, { recursive: true });
        console.log('Created recordings directory:', recordingsDir);
    }

    // Express app
    const app = express();
    app.use(cors());
    app.use(express.json());

    // Health check
    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', time: new Date().toISOString() });
    });

    // Routes
    app.use('/api/superadmin', superadminRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/user', userRoutes);
    app.use('/api/recordings', recordingsRoutes);
    app.use('/api/public', publicRoutes);

    // Serve uploaded logos statically
    const logosDir = path.resolve(process.cwd(), 'logos');
    if (!fs.existsSync(logosDir)) {
        fs.mkdirSync(logosDir, { recursive: true });
        console.log('Created logos directory:', logosDir);
    }
    app.use('/api/logos', express.static(logosDir));

    // Create HTTP server
    const httpServer = http.createServer(app);

    // Setup WebSocket
    setupWebSocket(httpServer);

    // Start server
    httpServer.listen(config.port, () => {
        console.log(`Server listening on port ${config.port}`);
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
