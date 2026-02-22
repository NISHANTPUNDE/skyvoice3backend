import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { Room } from '../models/Room';
import { User } from '../models/User';
import { createRouter, createWebRtcTransport } from '../media/mediasoupManager';
import { AuthPayload } from '../middleware/auth';
import * as mediasoup from 'mediasoup';

interface RoomState {
    router: mediasoup.types.Router;
    adminProducerTransport?: mediasoup.types.WebRtcTransport;
    adminProducer?: mediasoup.types.Producer;
    adminWs?: WebSocket;
    listeners: Map<
        string,
        {
            ws: WebSocket;
            transport?: mediasoup.types.WebRtcTransport;
            consumer?: mediasoup.types.Consumer;
            userName: string;
        }
    >;
}

const rooms = new Map<string, RoomState>();

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
    // Send to admin
    if (room.adminWs && room.adminWs !== excludeWs) {
        sendJson(room.adminWs, data);
    }
    // Send to listeners
    for (const [, listener] of room.listeners) {
        if (listener.ws !== excludeWs) {
            sendJson(listener.ws, data);
        }
    }
}

function getListenersList(roomId: string): { userId: string; userName: string }[] {
    const room = rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.listeners.entries()).map(([userId, l]) => ({
        userId,
        userName: l.userName,
    }));
}

export function setupWebSocket(httpServer: HttpServer): void {
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', (ws: WebSocket, req) => {
        // Authenticate via query param: ?token=xxx
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
        case 'create-room': {
            if (auth.role !== 'admin') {
                sendJson(ws, { type: 'error', message: 'Only admins can create rooms' });
                return;
            }

            const roomId = uuidv4();
            const router = await createRouter();
            const roomState: RoomState = {
                router,
                adminWs: ws,
                listeners: new Map(),
            };
            rooms.set(roomId, roomState);

            // Save to DB
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

        case 'create-producer-transport': {
            if (auth.role !== 'admin') {
                sendJson(ws, { type: 'error', message: 'Only admins can produce audio' });
                return;
            }
            const room = rooms.get(msg.roomId);
            if (!room) {
                sendJson(ws, { type: 'error', message: 'Room not found' });
                return;
            }

            const transport = await createWebRtcTransport(room.router);
            room.adminProducerTransport = transport;

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
            if (!room || !room.adminProducerTransport) {
                sendJson(ws, { type: 'error', message: 'Transport not found' });
                return;
            }
            await room.adminProducerTransport.connect({ dtlsParameters: msg.dtlsParameters });
            sendJson(ws, { type: 'producer-transport-connected' });
            break;
        }

        case 'produce': {
            const room = rooms.get(msg.roomId);
            if (!room || !room.adminProducerTransport) {
                sendJson(ws, { type: 'error', message: 'Transport not found' });
                return;
            }
            const producer = await room.adminProducerTransport.produce({
                kind: msg.kind,
                rtpParameters: msg.rtpParameters,
            });
            room.adminProducer = producer;

            sendJson(ws, { type: 'produced', producerId: producer.id });
            break;
        }

        case 'join-room': {
            if (auth.role !== 'user') {
                sendJson(ws, { type: 'error', message: 'Only users can join as listeners' });
                return;
            }

            // Verify user is not deleted
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

            room.listeners.set(auth.id, { ws, userName: user.name });

            // Notify admin about new listener
            broadcastToRoom(msg.roomId, {
                type: 'listener-joined',
                userId: auth.id,
                userName: user.name,
                listeners: getListenersList(msg.roomId),
            }, ws);

            sendJson(ws, {
                type: 'room-joined',
                roomId: msg.roomId,
                rtpCapabilities: room.router.rtpCapabilities,
                hasProducer: !!room.adminProducer,
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
            const listener = room.listeners.get(auth.id);
            if (listener) {
                listener.transport = transport;
            }

            sendJson(ws, {
                type: 'consumer-transport-created',
                params: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                },
            });
            break;
        }

        case 'connect-consumer-transport': {
            const room = rooms.get(msg.roomId);
            if (!room) {
                sendJson(ws, { type: 'error', message: 'Room not found' });
                return;
            }
            const listener = room.listeners.get(auth.id);
            if (!listener || !listener.transport) {
                sendJson(ws, { type: 'error', message: 'Transport not found' });
                return;
            }
            await listener.transport.connect({ dtlsParameters: msg.dtlsParameters });
            sendJson(ws, { type: 'consumer-transport-connected' });
            break;
        }

        case 'consume': {
            const room = rooms.get(msg.roomId);
            if (!room || !room.adminProducer) {
                sendJson(ws, { type: 'error', message: 'No audio to consume' });
                return;
            }

            const listener = room.listeners.get(auth.id);
            if (!listener || !listener.transport) {
                sendJson(ws, { type: 'error', message: 'Transport not found' });
                return;
            }

            // Check if the router can consume
            if (
                !room.router.canConsume({
                    producerId: room.adminProducer.id,
                    rtpCapabilities: msg.rtpCapabilities,
                })
            ) {
                sendJson(ws, { type: 'error', message: 'Cannot consume' });
                return;
            }

            const consumer = await listener.transport.consume({
                producerId: room.adminProducer.id,
                rtpCapabilities: msg.rtpCapabilities,
                paused: false,
            });

            listener.consumer = consumer;

            sendJson(ws, {
                type: 'consumed',
                params: {
                    id: consumer.id,
                    producerId: room.adminProducer.id,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                },
            });
            break;
        }

        case 'resume-consumer': {
            const room = rooms.get(msg.roomId);
            if (!room) return;
            const listener = room.listeners.get(auth.id);
            if (listener?.consumer) {
                await listener.consumer.resume();
                sendJson(ws, { type: 'consumer-resumed' });
            }
            break;
        }

        case 'leave-room': {
            const room = rooms.get(msg.roomId);
            if (!room) return;

            cleanupListener(room, auth.id, msg.roomId);
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
                cleanupListener(room, msg.userId, msg.roomId);
                // Close the kicked user's WebSocket
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

        default:
            sendJson(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
}

async function endRoom(roomId: string, adminWs?: WebSocket) {
    const room = rooms.get(roomId);
    if (!room) return;

    // Notify all listeners and close their connections
    for (const [, listener] of room.listeners) {
        sendJson(listener.ws, { type: 'room-ended', roomId });
        try { if (listener.consumer) listener.consumer.close(); } catch { /* ignore */ }
        try { if (listener.transport) listener.transport.close(); } catch { /* ignore */ }
        try { listener.ws.close(); } catch { /* ignore */ }
    }

    // Close admin transport and producer
    try { if (room.adminProducer) room.adminProducer.close(); } catch { /* ignore */ }
    try { if (room.adminProducerTransport) room.adminProducerTransport.close(); } catch { /* ignore */ }
    try { room.router.close(); } catch { /* ignore */ }

    rooms.delete(roomId);
    await Room.updateOne({ roomId }, { isActive: false }).catch(console.error);

    // Confirm to admin
    if (adminWs) {
        sendJson(adminWs, { type: 'room-ended', roomId });
    }
}

function cleanupListener(room: RoomState, userId: string, roomId: string) {
    const listener = room.listeners.get(userId);
    if (!listener) return;

    try { if (listener.consumer) listener.consumer.close(); } catch { /* ignore */ }
    try { if (listener.transport) listener.transport.close(); } catch { /* ignore */ }
    room.listeners.delete(userId);

    // Notify everyone about updated listeners list
    broadcastToRoom(roomId, {
        type: 'listener-left',
        userId,
        listeners: getListenersList(roomId),
    });
}

function handleDisconnect(ws: WebSocket, auth: AuthPayload) {
    // Find all rooms this user is in and clean up
    for (const [roomId, room] of rooms) {
        if (auth.role === 'admin' && room.adminWs === ws) {
            // Admin disconnected — end the room
            endRoom(roomId).catch(console.error);
        } else if (auth.role === 'user') {
            // Check if this user's WS matches the disconnecting one
            const listener = room.listeners.get(auth.id);
            if (listener && listener.ws === ws) {
                cleanupListener(room, auth.id, roomId);
            }
        }
    }
}
