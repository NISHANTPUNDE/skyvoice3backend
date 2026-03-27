import { Router, Request, Response } from 'express';
import { Admin } from '../models/Admin';

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

        // The host might be exactly the subdomain they entered, e.g. 'admin1.skai.deveraa.com'
        // We match it case-insensitively
        const admin = await Admin.findOne({ subdomain: host.toLowerCase() });

        if (!admin) {
            // If no match found, fallback to default branding
            res.json({
                found: false,
                name: 'Shubhvoice',
                logoUrl: null, // Frontend will use default icon.jpeg
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

export default router;
