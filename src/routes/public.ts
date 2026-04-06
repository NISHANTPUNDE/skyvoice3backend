import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { Admin } from '../models/Admin';
import { getRecordingFilePath } from '../media/recording';

const router = Router();

// GET /api/public/config
// Returns the branding configuration for a specific subdomain
router.get('/config', async (req: Request, res: Response): Promise<void> => {
    try {
        const host = req.query.host as string;
        if (!host) {
            res.status(400).json({ error: 'host query parameter is required' });
            return;
        }

        const exactHost = host.toLowerCase();
        
        // Generate ['admin2.skai.deveraa.com', 'admin2.skai.deveraa', 'admin2.skai', 'admin2']
        const parts = exactHost.split('.');
        const prefixes = [];
        for (let i = parts.length; i > 0; i--) {
            prefixes.push(parts.slice(0, i).join('.'));
        }

        const admin = await Admin.findOne({ subdomain: { $in: prefixes } });

        if (!admin) {
            // If no match found, fallback to default branding
            res.json({
                found: false,
                name: 'VoicesUp',
                logoUrl: null, // Frontend will use default icon2.png
            });
            return;
        }

        res.json({
            found: true,
            adminId: admin._id,
            name: admin.name,
            logoUrl: admin.logoUrl || null,
        });

    } catch (err) {
        console.error('Public config error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/public/download-apk
// Serves the latest APK file from src/apk directory
router.get('/download-apk', (req: Request, res: Response): void => {
    try {
        const apkDir = path.resolve(process.cwd(), 'src', 'apk');
        if (!fs.existsSync(apkDir)) {
            res.status(404).json({ error: 'APK directory not found' });
            return;
        }

        const files = fs.readdirSync(apkDir);
        const apkFile = files.find(file => file.endsWith('.apk'));

        if (!apkFile) {
            res.status(404).json({ error: 'No APK file available for download' });
            return;
        }

        const filepath = path.join(apkDir, apkFile);
        res.download(filepath, apkFile); // Forces download
    } catch (err) {
        console.error('APK download error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/public/recordings/stream
// Completely public endpoint to stream recordings for native mobile players
router.get('/recordings/stream', async (req: Request, res: Response): Promise<void> => {
    try {
        const roomId = req.query.roomId as string;
        const userId = req.query.userId as string;
        const filename = req.query.filename as string;

        if (!roomId || !userId || !filename) {
            res.status(400).json({ error: 'roomId, userId, and filename parameters required' });
            return;
        }

        const filepath = getRecordingFilePath(roomId, userId, filename);
        if (!filepath) {
            res.status(404).json({ error: 'Recording not found' });
            return;
        }

        const contentType = filename.endsWith('.webm') ? 'audio/webm' : 'audio/mpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(filename).replace(/"/g, '')}"`);
        res.sendFile(filepath);
    } catch (err) {
        console.error('Public streaming error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
