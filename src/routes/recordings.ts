import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { authMiddleware } from '../middleware/auth';
import { getRecordingsForRoom, getRecordingFilePath, getRecordingsDir } from '../media/recording';

const router = Router();

// GET /api/admin/recordings/:roomId — list all recording segments for a room
router.get('/:roomId', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const roomId = Array.isArray(req.params.roomId) ? req.params.roomId[0] : req.params.roomId;
        const recordings = getRecordingsForRoom(roomId);
        res.json(recordings);
    } catch (err) {
        console.error('List recordings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/recordings/:roomId/:userId — list segments for specific user
router.get('/:roomId/:userId', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const roomId = Array.isArray(req.params.roomId) ? req.params.roomId[0] : req.params.roomId;
        const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
        const all = getRecordingsForRoom(roomId);
        const segments = all[userId] || [];
        res.json(segments);
    } catch (err) {
        console.error('List user recordings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/recordings/download/:roomId/:userId/:filename — download individual segment
router.get('/download/:roomId/:userId/:filename', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const roomId = Array.isArray(req.params.roomId) ? req.params.roomId[0] : req.params.roomId;
        const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
        const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
        const filepath = getRecordingFilePath(roomId, userId, filename);
        if (!filepath) {
            res.status(404).json({ error: 'Recording not found' });
            return;
        }
        res.download(filepath, filename);
    } catch (err) {
        console.error('Download recording error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
