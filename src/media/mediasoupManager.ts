import * as mediasoup from 'mediasoup';
import { config } from '../config';

let workers: mediasoup.types.Worker[] = [];
let nextWorkerIdx = 0;

export async function createWorkers(): Promise<void> {
    for (let i = 0; i < config.mediasoup.numWorkers; i++) {
        const worker = await mediasoup.createWorker({
            rtcMinPort: config.mediasoup.worker.rtcMinPort,
            rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags as any,
        });

        worker.on('died', () => {
            console.error(`MediaSoup Worker died [pid:${worker.pid}], exiting...`);
            setTimeout(() => process.exit(1), 2000);
        });

        workers.push(worker);
        console.log(`MediaSoup Worker created [pid:${worker.pid}]`);
    }
}

function getNextWorker(): mediasoup.types.Worker {
    const worker = workers[nextWorkerIdx];
    nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
    return worker;
}

export async function createRouter(): Promise<mediasoup.types.Router> {
    const worker = getNextWorker();
    const router = await worker.createRouter({
        mediaCodecs: config.mediasoup.router.mediaCodecs as mediasoup.types.RtpCodecCapability[],
    });
    return router;
}

export async function createWebRtcTransport(
    router: mediasoup.types.Router
): Promise<mediasoup.types.WebRtcTransport> {
    const transport = await router.createWebRtcTransport({
        listenIps: config.mediasoup.webRtcTransport.listenIps as mediasoup.types.TransportListenIp[],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate:
            config.mediasoup.webRtcTransport.initialAvailableOutgoingBitrate,
    });

    if (config.mediasoup.webRtcTransport.maxIncomingBitrate) {
        try {
            await transport.setMaxIncomingBitrate(config.mediasoup.webRtcTransport.maxIncomingBitrate);
        } catch {
            // ignore
        }
    }

    return transport;
}

export async function createPlainTransport(
    router: mediasoup.types.Router
): Promise<mediasoup.types.PlainTransport> {
    const transport = await router.createPlainTransport({
        listenIp: config.mediasoup.plainTransport?.listenIp || config.mediasoup.webRtcTransport.listenIps[0] as mediasoup.types.TransportListenIp,
        rtcpMux: false,
        comedia: true,
        enableSrtp: false,
    });
    return transport;
}
