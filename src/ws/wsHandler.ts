import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { Room } from '../models/Room';
import { User } from '../models/User';
import { createRouter, createWebRtcTransport, createPlainTransport } from '../media/mediasoupManager';
import { AuthPayload } from '../middleware/auth';
import * as mediasoup from 'mediasoup';
import { startRecording, stopRecording, RecordingInfo } from '../media/recording';

// ─── Per-user state within a room ───
interface ListenerState {
    ws: WebSocket;
    userName: string;
    // Consumer side (hearing admin)
    consumerTransport?: mediasoup.types.WebRtcTransport;
    consumer?: mediasoup.types.Consumer;
    // Producer side (speaking via PTT)
    producerTransport?: mediasoup.types.WebRtcTransport;
    producer?: mediasoup.types.Producer;
    isPtt: boolean;
}

// ─── Admin's consumer for a specific user ───
interface AdminConsumerEntry {
    transport: mediasoup.types.WebRtcTransport;
    consumer: mediasoup.types.Consumer;
}

// ─── Admin state within a room ───
interface AdminState {
    ws: WebSocket;
    adminName: string;
    // Producer side (admin speaking)
    producerTransport?: mediasoup.types.WebRtcTransport;
    producer?: mediasoup.types.Producer;
    // Consumers for each user (admin hearing users)
    consumers: Map<string, AdminConsumerEntry>;
}

// ─── Room state ───
// ══════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════

interface RoomState {
    router: mediasoup.types.Router;
    creatorAdminId: string;
    adminDisconnectTimer?: NodeJS.Timeout;
    admins: Map<string, { // adminId -> AdminConnection
        ws: WebSocket;
        adminName: string;
        producer?: mediasoup.types.Producer;
        producerTransport?: mediasoup.types.WebRtcTransport;
        consumers: Map<string, { // userId -> admin's consumer for that user
            consumer?: mediasoup.types.Consumer;
            transport?: mediasoup.types.WebRtcTransport;
        }>;
    }>;
    listeners: Map<string, {
        ws: WebSocket;
        userName: string;
        isPtt: boolean;
        producer?: mediasoup.types.Producer;
        producerTransport?: mediasoup.types.WebRtcTransport;
        consumer?: mediasoup.types.Consumer;         // consumes active admin
        consumerTransport?: mediasoup.types.WebRtcTransport;
    }>;
}

const rooms = new Map<string, RoomState>();

export function getActiveRoomIds(): string[] {
    return Array.from(rooms.keys());
}

export function isRoomActive(roomId: string): boolean {
    return rooms.has(roomId);
}

const ADMIN_GRACE_PERIOD_MS = 15_000; // 15s grace period for admin reconnect
const MIN_PTT_DURATION_MS = 800;      // Minimum PTT duration for valid recording

function sendJson(ws: WebSocket, data: any) {
    try {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    } catch (err) {
        console.error('sendJson error:', err);
    }
}

function broadcastToRoom(roomId: string, data: any, excludeWs?: WebSocket) {
    const room = rooms.get(roomId);
    if (!room) return;
    // Broadcast to all admins
    for (const [, admin] of room.admins) {
        if (admin.ws !== excludeWs) {
            sendJson(admin.ws, data);
        }
    }
    // Broadcast to all listeners
    for (const [, listener] of room.listeners) {
        if (listener.ws !== excludeWs) {
            sendJson(listener.ws, data);
        }
    }
}

function broadcastToAdmins(roomId: string, data: any, excludeWs?: WebSocket) {
    const room = rooms.get(roomId);
    if (!room) return;
    for (const [, admin] of room.admins) {
        if (admin.ws !== excludeWs) {
            sendJson(admin.ws, data);
        }
    }
}

function getListenersList(roomId: string): { userId: string; userName: string; isPtt: boolean }[] {
    const room = rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.listeners.entries()).map(([userId, l]) => ({
        userId,
        userName: l.userName,
        isPtt: l.isPtt,
    }));
}

export function setupWebSocket(httpServer: HttpServer): void {
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    // ─── Keepalive: ping all clients every 30s ───
    const PING_INTERVAL = 30_000;
    const aliveMap = new WeakMap<WebSocket, boolean>();

    const keepaliveTimer = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (aliveMap.get(ws) === false) {
                console.log('WS keepalive: terminating unresponsive client');
                ws.terminate();
                return;
            }
            aliveMap.set(ws, false);
            try { ws.ping(); } catch { /* ok */ }
        });
    }, PING_INTERVAL);

    wss.on('close', () => clearInterval(keepaliveTimer));

    wss.on('connection', (ws: WebSocket, req) => {
        aliveMap.set(ws, true);
        ws.on('pong', () => aliveMap.set(ws, true));

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');

        let auth: AuthPayload;
        try {
            if (!token) throw new Error('No token');
            auth = jwt.verify(token, config.jwtSecret) as AuthPayload;
        } catch {
            sendJson(ws, { type: 'error', message: 'Authentication failed' });
            ws.close();
            return;
        }

        console.log(`WS connected: role=${auth.role}, id=${auth.id}`);

        ws.on('message', async (rawMsg) => {
            try {
                const msg = JSON.parse(rawMsg.toString());
                await handleMessage(ws, auth, msg);
            } catch (err) {
                console.error('WS message error:', err);
                sendJson(ws, { type: 'error', message: 'Invalid message' });
            }
        });

        ws.on('close', () => {
            console.log(`WS disconnected: role=${auth.role}, id=${auth.id}`);
            handleDisconnect(ws, auth);
        });

        ws.on('error', (err) => {
            console.error(`WS error: role=${auth.role}, id=${auth.id}`, err);
        });
    });
}

async function handleMessage(ws: WebSocket, auth: AuthPayload, msg: any) {
    switch (msg.type) {

        // ══════════════════════════════════════════
        //  ROOM LIFECYCLE
        // ══════════════════════════════════════════

        case 'create-room': {
            if (auth.role !== 'admin') {
                sendJson(ws, { type: 'error', message: 'Only admins can create rooms' });
                return;
            }

            const admin = await import('../models/Admin').then(m => m.Admin.findById(auth.id));
            if (!admin) {
                sendJson(ws, { type: 'error', message: 'Admin not found' });
                return;
            }

            // Check if admin already has an active room (reconnect after refresh)
            for (const [existingRoomId, existingRoom] of rooms) {
                if (existingRoom.creatorAdminId === auth.id) {
                    // Cancel grace period timer if active
                    if (existingRoom.adminDisconnectTimer) {
                        clearTimeout(existingRoom.adminDisconnectTimer);
                        existingRoom.adminDisconnectTimer = undefined;
                        console.log(`Admin ${auth.id} reconnected to room ${existingRoomId} (grace period cancelled)`);
                    }
                    // Reattach admin WS to existing room
                    const existingAdmin = existingRoom.admins.get(auth.id);
                    if (existingAdmin) {
                        existingAdmin.ws = ws;
                        // Clean old media (admin needs to re-setup producer)
                        try { existingAdmin.producer?.close(); } catch { /* ok */ }
                        try { existingAdmin.producerTransport?.close(); } catch { /* ok */ }
                        existingAdmin.producer = undefined;
                        existingAdmin.producerTransport = undefined;
                    } else {
                        existingRoom.admins.set(auth.id, {
                            ws,
                            adminName: admin.name,
                            consumers: new Map(),
                        });
                    }
                    sendJson(ws, {
                        type: 'room-created',
                        roomId: existingRoomId,
                        rtpCapabilities: existingRoom.router.rtpCapabilities,
                    });
                    // Send current listeners list
                    sendJson(ws, {
                        type: 'listener-joined',
                        listeners: getListenersList(existingRoomId),
                    });
                    return;
                }
            }

            const roomId = uuidv4();
            const router = await createRouter();
            const roomState: RoomState = {
                router,
                creatorAdminId: auth.id,
                admins: new Map(),
                listeners: new Map(),
            };
            
            // Add creator as first admin
            roomState.admins.set(auth.id, {
                ws,
                adminName: admin.name,
                consumers: new Map(),
            });
            
            rooms.set(roomId, roomState);

            await Room.create({ adminId: auth.id, roomId, isActive: true });

            sendJson(ws, {
                type: 'room-created',
                roomId,
                rtpCapabilities: router.rtpCapabilities,
            });
            break;
        }

        case 'get-rtp-capabilities': {
            const room = rooms.get(msg.roomId);
            if (!room) {
                sendJson(ws, { type: 'error', message: 'Room not found' });
                return;
            }
            sendJson(ws, {
                type: 'rtp-capabilities',
                rtpCapabilities: room.router.rtpCapabilities,
            });
            break;
        }

        // ══════════════════════════════════════════
        //  PRODUCER TRANSPORT (Admin + User)
        // ══════════════════════════════════════════

        case 'create-producer-transport': {
            if (auth.role !== 'admin' && auth.role !== 'user') {
                sendJson(ws, { type: 'error', message: 'Invalid role' });
                return;
            }
            const room = rooms.get(msg.roomId);
            if (!room) {
                sendJson(ws, { type: 'error', message: 'Room not found' });
                return;
            }

            const transport = await createWebRtcTransport(room.router);

            if (auth.role === 'admin') {
                const admin = room.admins.get(auth.id);
                if (admin) {
                    admin.producerTransport = transport;
                }
            } else {
                const listener = room.listeners.get(auth.id);
                if (listener) {
                    listener.producerTransport = transport;
                }
            }

            sendJson(ws, {
                type: 'producer-transport-created',
                params: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                },
            });
            break;
        }

        case 'connect-producer-transport': {
            const room = rooms.get(msg.roomId);
            if (!room) {
                sendJson(ws, { type: 'error', message: 'Room not found' });
                return;
            }

            let transport: mediasoup.types.WebRtcTransport | undefined;
            if (auth.role === 'admin') {
                transport = room.admins.get(auth.id)?.producerTransport;
            } else {
                transport = room.listeners.get(auth.id)?.producerTransport;
            }

            if (!transport) {
                sendJson(ws, { type: 'error', message: 'Transport not found' });
                return;
            }

            await transport.connect({ dtlsParameters: msg.dtlsParameters });
            sendJson(ws, { type: 'producer-transport-connected' });
            break;
        }

        case 'produce': {
            const room = rooms.get(msg.roomId);
            if (!room) {
                sendJson(ws, { type: 'error', message: 'Room not found' });
                return;
            }

            if (auth.role === 'admin') {
                // Admin producing — create consumer for all existing users
                const admin = room.admins.get(auth.id);
                if (!admin?.producerTransport) {
                    sendJson(ws, { type: 'error', message: 'Transport not found' });
                    return;
                }
                const producer = await admin.producerTransport.produce({
                    kind: msg.kind,
                    rtpParameters: msg.rtpParameters,
                });
                admin.producer = producer;
                sendJson(ws, { type: 'produced', producerId: producer.id });
                
                // Notify all users that a new admin producer is available
                for (const [userId, listener] of room.listeners) {
                    sendJson(listener.ws, {
                        type: 'admin-producer-available',
                        adminId: auth.id,
                        adminName: admin.adminName,
                        producerId: producer.id,
                        roomId: msg.roomId,
                    });
                }
            } else {
                // User producing — only create consumer for all admins
                const listener = room.listeners.get(auth.id);
                if (!listener || !listener.producerTransport) {
                    sendJson(ws, { type: 'error', message: 'Transport not found' });
                    return;
                }
                const producer = await listener.producerTransport.produce({
                    kind: msg.kind,
                    rtpParameters: msg.rtpParameters,
                    paused: false, // Ensure both admins and users ALWAYS start strictly unpaused and "HOT"
                });
                listener.producer = producer;

                // Notify all admins that a new user producer is available
                for (const [adminId, admin] of room.admins) {
                    sendJson(admin.ws, {
                        type: 'user-producer-available',
                        userId: auth.id,
                        userName: listener.userName,
                        producerId: producer.id,
                        roomId: msg.roomId,
                    });
                }

                sendJson(ws, { type: 'produced', producerId: producer.id });
            }
            break;
        }

        // ══════════════════════════════════════════
        //  JOIN / CONSUMER TRANSPORT (Admin + User)
        // ══════════════════════════════════════════

        case 'join-room': {
            if (auth.role !== 'user') {
                sendJson(ws, { type: 'error', message: 'Only users can join as listeners' });
                return;
            }

            const user = await User.findById(auth.id);
            if (!user || user.isDeleted) {
                sendJson(ws, { type: 'error', message: 'Account not active' });
                ws.close();
                return;
            }

            const room = rooms.get(msg.roomId);
            if (!room) {
                sendJson(ws, { type: 'error', message: 'Room not found or has ended' });
                return;
            }

            // FIX #6 & #7: Clean up existing listener entry (duplicate device / reconnect)
            const existingListener = room.listeners.get(auth.id);
            if (existingListener) {
                console.log(`User ${auth.id} re-joining room ${msg.roomId}, cleaning up old connection`);
                // Stop any active recording (regardless of isPtt flag — handles race conditions)
                try { await stopRecording(msg.roomId, auth.id); } catch { /* ok */ }
                // Close old transports/consumers
                try { existingListener.consumer?.close(); } catch { /* ok */ }
                try { existingListener.consumerTransport?.close(); } catch { /* ok */ }
                try { existingListener.producer?.close(); } catch { /* ok */ }
                try { existingListener.producerTransport?.close(); } catch { /* ok */ }
                // Close old WS if different
                if (existingListener.ws !== ws) {
                    try { existingListener.ws.close(); } catch { /* ok */ }
                }
                // Clean up admin consumers for this user
                for (const [, admin] of room.admins) {
                    const entry = admin.consumers.get(auth.id);
                    if (entry) {
                        try { entry.consumer?.close(); } catch { /* ok */ }
                        try { entry.transport?.close(); } catch { /* ok */ }
                        admin.consumers.delete(auth.id);
                    }
                }
            }

            room.listeners.set(auth.id, {
                ws,
                userName: user.name,
                isPtt: false,
            });

            // Get list of admin producers
            const adminProducers = Array.from(room.admins.entries())
                .filter(([, admin]) => admin.producer)
                .map(([adminId, admin]) => ({
                    adminId,
                    adminName: admin.adminName,
                    producerId: admin.producer!.id,
                }));

            // Notify all admins about new listener
            broadcastToAdmins(msg.roomId, {
                type: 'listener-joined',
                userId: auth.id,
                userName: user.name,
                listeners: getListenersList(msg.roomId),
            });

            sendJson(ws, {
                type: 'room-joined',
                roomId: msg.roomId,
                rtpCapabilities: room.router.rtpCapabilities,
                adminProducers,
                listeners: getListenersList(msg.roomId),
            });
            break;
        }

        case 'create-consumer-transport': {
            const room = rooms.get(msg.roomId);
            if (!room) {
                sendJson(ws, { type: 'error', message: 'Room not found' });
                return;
            }

            const transport = await createWebRtcTransport(room.router);

            if (auth.role === 'user') {
                // User creates consumer transport to hear all admins
                const listener = room.listeners.get(auth.id);
                if (listener) {
                    listener.consumerTransport = transport;
                }
            } else if (auth.role === 'admin') {
                // Admin creates consumer transport to hear a specific user
                const userId = msg.userId;
                const admin = room.admins.get(auth.id);
                if (userId && admin) {
                    admin.consumers.set(userId, {
                        transport,
                        consumer: undefined as any,
                    });
                }
            }

            sendJson(ws, {
                type: 'consumer-transport-created',
                params: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                },
                userId: msg.userId, // Echo back for admin to correlate
            });
            break;
        }

        case 'connect-consumer-transport': {
            const room = rooms.get(msg.roomId);
            if (!room) {
                sendJson(ws, { type: 'error', message: 'Room not found' });
                return;
            }

            let transport: mediasoup.types.WebRtcTransport | undefined;
            if (auth.role === 'user') {
                transport = room.listeners.get(auth.id)?.consumerTransport;
            } else if (auth.role === 'admin' && msg.userId) {
                const admin = room.admins.get(auth.id);
                transport = admin?.consumers.get(msg.userId)?.transport;
            }

            if (!transport) {
                sendJson(ws, { type: 'error', message: 'Transport not found' });
                return;
            }
            await transport.connect({ dtlsParameters: msg.dtlsParameters });
            sendJson(ws, { type: 'consumer-transport-connected', userId: msg.userId });
            break;
        }

        case 'consume': {
            const room = rooms.get(msg.roomId);
            if (!room) {
                sendJson(ws, { type: 'error', message: 'Room not found' });
                return;
            }

            if (auth.role === 'user') {
                // User consuming an admin's producer
                const adminId = msg.adminId;
                if (!adminId) {
                    sendJson(ws, { type: 'error', message: 'Admin ID required' });
                    return;
                }
                const admin = room.admins.get(adminId);
                if (!admin?.producer) {
                    sendJson(ws, { type: 'error', message: 'No audio to consume' });
                    return;
                }
                const listener = room.listeners.get(auth.id);
                if (!listener?.consumerTransport) {
                    sendJson(ws, { type: 'error', message: 'Transport not found' });
                    return;
                }
                
                // Validate RTP capabilities
                if (!msg.rtpCapabilities) {
                    sendJson(ws, { type: 'error', message: 'RTP capabilities required' });
                    return;
                }
                
                if (!room.router.canConsume({ producerId: admin.producer.id, rtpCapabilities: msg.rtpCapabilities })) {
                    console.error('[CONSUME] Cannot consume - incompatible capabilities');
                    sendJson(ws, { type: 'error', message: 'Cannot consume - incompatible audio format' });
                    return;
                }
                
                try {
                    const consumer = await listener.consumerTransport.consume({
                        producerId: admin.producer.id,
                        rtpCapabilities: msg.rtpCapabilities,
                        paused: false,
                    });
                    listener.consumer = consumer;

                    console.log('[CONSUME] Consumer created for user:', auth.id, 'consumer ID:', consumer.id);

                    sendJson(ws, {
                        type: 'consumed',
                        params: {
                            id: consumer.id,
                            producerId: admin.producer.id,
                            kind: consumer.kind,
                            rtpParameters: consumer.rtpParameters,
                        },
                        adminId,
                    });
                } catch (err: any) {
                    console.error('[CONSUME] Error creating consumer:', err.message);
                    sendJson(ws, { type: 'error', message: 'Failed to create consumer: ' + err.message });
                }
            } else if (auth.role === 'admin' && msg.userId) {
                // Admin consuming a user's producer
                const listener = room.listeners.get(msg.userId);
                if (!listener?.producer) {
                    sendJson(ws, { type: 'error', message: 'User has no producer' });
                    return;
                }
                const admin = room.admins.get(auth.id);
                const adminConsumerEntry = admin?.consumers.get(msg.userId);
                if (!adminConsumerEntry?.transport) {
                    sendJson(ws, { type: 'error', message: 'Transport not found' });
                    return;
                }
                if (!room.router.canConsume({ producerId: listener.producer.id, rtpCapabilities: msg.rtpCapabilities })) {
                    sendJson(ws, { type: 'error', message: 'Cannot consume user audio' });
                    return;
                }
                
                try {
                    const consumer = await adminConsumerEntry.transport.consume({
                        producerId: listener.producer.id,
                        rtpCapabilities: msg.rtpCapabilities,
                        paused: false,
                    });
                    adminConsumerEntry.consumer = consumer;

                    sendJson(ws, {
                        type: 'consumed',
                        params: {
                            id: consumer.id,
                            producerId: listener.producer.id,
                            kind: consumer.kind,
                            rtpParameters: consumer.rtpParameters,
                        },
                        userId: msg.userId,
                    });
                } catch (err: any) {
                    console.error('[CONSUME] Error creating admin consumer:', err.message);
                    sendJson(ws, { type: 'error', message: 'Failed to create consumer: ' + err.message });
                }
            }
            break;
        }

        case 'resume-consumer': {
            const room = rooms.get(msg.roomId);
            if (!room) return;
            if (auth.role === 'user') {
                const listener = room.listeners.get(auth.id);
                if (listener?.consumer) {
                    await listener.consumer.resume();
                    sendJson(ws, { type: 'consumer-resumed' });
                }
            } else if (auth.role === 'admin' && msg.userId) {
                const admin = room.admins.get(auth.id);
                const entry = admin?.consumers.get(msg.userId);
                if (entry?.consumer) {
                    await entry.consumer.resume();
                    sendJson(ws, { type: 'consumer-resumed', userId: msg.userId });
                }
            }
            break;
        }

        // ══════════════════════════════════════════
        //  PUSH-TO-TALK
        // ══════════════════════════════════════════

        case 'ptt-start': {
            if (auth.role !== 'user') return;
            const room = rooms.get(msg.roomId);
            if (!room) return;

            const listener = room.listeners.get(auth.id);
            if (!listener?.producer) return;

            listener.isPtt = true;
            (listener as any)._pttStartTime = Date.now();

            // Start recording for each admin FIRST so FFmpeg's UDP port is fully listening.
            try {
                await startRecordingForUser(room, msg.roomId, auth.id);
            } catch (err) {
                console.error('Failed to start recording:', err);
            }

            // Stop FFmpeg completely!
            // No producer.resume() needed — backend is always running hot!

            // Notify all admins
            broadcastToAdmins(msg.roomId, {
                type: 'ptt-started',
                userId: auth.id,
                userName: listener.userName,
                roomId: msg.roomId,
                listeners: getListenersList(msg.roomId),
            });
            break;
        }

        case 'ptt-end': {
            if (auth.role !== 'user') return;
            const room = rooms.get(msg.roomId);
            if (!room) return;

            const listener = room.listeners.get(auth.id);
            if (!listener?.producer) return;

            listener.isPtt = false;

            // No producer.pause() needed — mobile App natively mutes the track to save bandwidth!

            // Notify all admins
            broadcastToAdmins(msg.roomId, {
                type: 'ptt-ended',
                userId: auth.id,
                userName: listener.userName,
                roomId: msg.roomId,
                listeners: getListenersList(msg.roomId),
            });

            // FIX #8: Ensure minimum PTT duration for valid recording
            const pttStartTime = (listener as any)._pttStartTime || 0;
            const elapsed = Date.now() - pttStartTime;
            if (elapsed < MIN_PTT_DURATION_MS) {
                await new Promise(resolve => setTimeout(resolve, MIN_PTT_DURATION_MS - elapsed));
            }

            // Stop recording
            try {
                const recordingInfo = await stopRecording(msg.roomId, auth.id);
                if (recordingInfo) {
                    // Notify all admins about saved recording
                    broadcastToAdmins(msg.roomId, {
                        type: 'recording-saved',
                        userId: auth.id,
                        userName: listener.userName,
                        recording: recordingInfo,
                    });
                    // Also notify the user who made the recording
                    sendJson(ws, {
                        type: 'recording-saved',
                        userId: auth.id,
                        userName: listener.userName,
                        recording: recordingInfo,
                    });
                }
            } catch (err) {
                console.error('Failed to stop recording:', err);
            }
            break;
        }

        // ══════════════════════════════════════════
        //  ROOM MANAGEMENT
        // ══════════════════════════════════════════

        case 'leave-room': {
            const room = rooms.get(msg.roomId);
            if (!room) return;
            await cleanupListener(room, auth.id, msg.roomId);
            sendJson(ws, { type: 'left-room' });
            break;
        }

        case 'kick-user': {
            if (auth.role !== 'admin') {
                sendJson(ws, { type: 'error', message: 'Only admins can kick users' });
                return;
            }
            const room = rooms.get(msg.roomId);
            if (!room) return;

            const listener = room.listeners.get(msg.userId);
            if (listener) {
                sendJson(listener.ws, { type: 'kicked', roomId: msg.roomId });
                await cleanupListener(room, msg.userId, msg.roomId);
                try { listener.ws.close(); } catch { /* ignore */ }
            }
            break;
        }

        case 'end-room': {
            if (auth.role !== 'admin') {
                sendJson(ws, { type: 'error', message: 'Only admins can end rooms' });
                return;
            }
            await endRoom(msg.roomId, ws);
            break;
        }

        case 'set-user-mute': {
            if (auth.role !== 'admin') {
                sendJson(ws, { type: 'error', message: 'Only admins can mute users' });
                return;
            }
            const room = rooms.get(msg.roomId);
            if (!room) return;

            const listener = room.listeners.get(msg.userId);
            if (listener) {
                // Relay mute override to the user
                sendJson(listener.ws, { 
                    type: 'admin-mute-override',
                    isMuted: msg.isMuted 
                });
            }
            break;
        }

        // ══════════════════════════════════════════
        //  LIVENESS
        // ══════════════════════════════════════════

        // Application-level heartbeat. The WebSocket protocol ping/pong is not
        // surfaced to React Native's WebSocket, so a client cannot otherwise tell
        // a half-open socket (phone suspended, NAT rebind) from a healthy idle one
        // until it tries to speak. Answering here lets the client detect a dead
        // link during a long silence and re-join on its own.
        case 'ping': {
            sendJson(ws, { type: 'pong', t: msg.t });
            break;
        }

        default:
            sendJson(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
}

// ══════════════════════════════════════════
//  RECORDING HELPERS
// ══════════════════════════════════════════

async function startRecordingForUser(room: RoomState, roomId: string, userId: string) {
    // Get first admin producer for recording (or could mix all admins)
    const firstAdmin = Array.from(room.admins.values()).find(a => a.producer);
    if (!firstAdmin?.producer) {
        console.log('No admin producer, skipping recording');
        return;
    }
    const listener = room.listeners.get(userId);
    if (!listener?.producer) {
        console.log('No user producer, skipping recording');
        return;
    }

    // Create PlainTransports for piping RTP to FFmpeg
    const userPlainTransport = await createPlainTransport(room.router);
    const adminPlainTransport = await createPlainTransport(room.router);

    // Create consumers on the PlainTransports
    const userConsumer = await userPlainTransport.consume({
        producerId: listener.producer.id,
        rtpCapabilities: room.router.rtpCapabilities,
        paused: false,
    });

    const adminConsumer = await adminPlainTransport.consume({
        producerId: firstAdmin.producer.id,
        rtpCapabilities: room.router.rtpCapabilities,
        paused: false,
    });

    await startRecording(roomId, userId, {
        userTransport: userPlainTransport,
        userConsumer,
        adminTransport: adminPlainTransport,
        adminConsumer,
    });
}

// ══════════════════════════════════════════
//  CLEANUP
// ══════════════════════════════════════════

async function endRoom(roomId: string, adminWs?: WebSocket) {
    const room = rooms.get(roomId);
    if (!room) return;

    // Stop ALL active recordings (not just isPtt users — handles race conditions)
    for (const [userId] of room.listeners) {
        try { await stopRecording(roomId, userId); } catch { /* ignore */ }
    }

    // Notify all listeners and close their connections
    for (const [, listener] of room.listeners) {
        sendJson(listener.ws, { type: 'room-ended', roomId });
        try { if (listener.consumer) listener.consumer.close(); } catch { /* ignore */ }
        try { if (listener.consumerTransport) listener.consumerTransport.close(); } catch { /* ignore */ }
        try { if (listener.producer) listener.producer.close(); } catch { /* ignore */ }
        try { if (listener.producerTransport) listener.producerTransport.close(); } catch { /* ignore */ }
        try { listener.ws.close(); } catch { /* ignore */ }
    }

    // Close all admin consumer transports
    for (const [, admin] of room.admins) {
        for (const [, entry] of admin.consumers) {
            try { if (entry.consumer) entry.consumer.close(); } catch { /* ignore */ }
            try { if (entry.transport) entry.transport.close(); } catch { /* ignore */ }
        }
        // Close admin transport and producer
        try { if (admin.producer) admin.producer.close(); } catch { /* ignore */ }
        try { if (admin.producerTransport) admin.producerTransport.close(); } catch { /* ignore */ }
    }

    try { room.router.close(); } catch { /* ignore */ }

    rooms.delete(roomId);
    await Room.updateOne({ roomId }, { isActive: false }).catch(console.error);

    // Notify all admins
    for (const [, admin] of room.admins) {
        sendJson(admin.ws, { type: 'room-ended', roomId });
    }
}

async function cleanupListener(room: RoomState, userId: string, roomId: string) {
    const listener = room.listeners.get(userId);
    if (!listener) return;

    // Stop recording — always try regardless of isPtt flag (handles race conditions)
    try {
        await stopRecording(roomId, userId);
    } catch (err) {
        console.error(`[Cleanup] Error stopping recording for ${userId}:`, err);
    }

    // Close user's consumer (hearing admins)
    try { if (listener.consumer) listener.consumer.close(); } catch { /* ignore */ }
    try { if (listener.consumerTransport) listener.consumerTransport.close(); } catch { /* ignore */ }

    // Close user's producer (speaking)
    try { if (listener.producer) listener.producer.close(); } catch { /* ignore */ }
    try { if (listener.producerTransport) listener.producerTransport.close(); } catch { /* ignore */ }

    // Close all admins' consumers for this user
    for (const [, admin] of room.admins) {
        const adminConsumerEntry = admin.consumers.get(userId);
        if (adminConsumerEntry) {
            try { if (adminConsumerEntry.consumer) adminConsumerEntry.consumer.close(); } catch { /* ignore */ }
            try { if (adminConsumerEntry.transport) adminConsumerEntry.transport.close(); } catch { /* ignore */ }
            admin.consumers.delete(userId);
        }
    }

    room.listeners.delete(userId);

    // Notify everyone about updated listeners list
    broadcastToRoom(roomId, {
        type: 'listener-left',
        userId,
        listeners: getListenersList(roomId),
    });
}

function handleDisconnect(ws: WebSocket, auth: AuthPayload) {
    for (const [roomId, room] of rooms) {
        if (auth.role === 'admin') {
            const admin = room.admins.get(auth.id);
            if (admin && admin.ws === ws) {
                if (room.creatorAdminId === auth.id) {
                    // FIX #3: Grace period — don't end room immediately
                    // Admin may be refreshing or reconnecting
                    console.log(`Admin ${auth.id} disconnected from room ${roomId}, starting ${ADMIN_GRACE_PERIOD_MS / 1000}s grace period`);
                    room.adminDisconnectTimer = setTimeout(() => {
                        room.adminDisconnectTimer = undefined;
                        console.log(`Admin ${auth.id} did not reconnect, ending room ${roomId}`);
                        endRoom(roomId).catch(console.error);
                    }, ADMIN_GRACE_PERIOD_MS);
                } else {
                    // Non-creator admin — remove immediately
                    for (const [, entry] of admin.consumers) {
                        try { if (entry.consumer) entry.consumer.close(); } catch { /* ignore */ }
                        try { if (entry.transport) entry.transport.close(); } catch { /* ignore */ }
                    }
                    try { if (admin.producer) admin.producer.close(); } catch { /* ignore */ }
                    try { if (admin.producerTransport) admin.producerTransport.close(); } catch { /* ignore */ }
                    room.admins.delete(auth.id);
                }
            }
        } else if (auth.role === 'user') {
            const listener = room.listeners.get(auth.id);
            if (listener && listener.ws === ws) {
                cleanupListener(room, auth.id, roomId).catch(console.error);
            }
        }
    }
}
