const WebSocket = require('ws');
const jsnes = require('jsnes');
const fetch = require('node-fetch');

// --- Configuration from Inputs ---
const WORLD = process.env.WORLD_NAME || 'owotness';
const MEMBER_KEY = process.env.MEMBER_KEY;
const ROM_URL = process.env.ROM_URL;
const WS_URL = `wss://ourworldoftext.com/${WORLD}/ws/${MEMBER_KEY ? '?key=' + MEMBER_KEY : ''}`;

const WIDTH = 256;
const HEIGHT = 240;
const TILE_C = 16; 
const TILE_R = 8;

let lastFrameData = new Uint32Array(WIDTH * (HEIGHT / 2));
let socket = null;
let nextEditId = Math.floor(Math.random() * 1000);
let buttonTimers = {};

const nes = new jsnes.NES({
    onFrame: (frameBuffer) => renderToOWOT(frameBuffer)
});

const CONTROLLER_MAP = {
    'up': jsnes.Controller.BUTTON_UP,
    'down': jsnes.Controller.BUTTON_DOWN,
    'left': jsnes.Controller.BUTTON_LEFT,
    'right': jsnes.Controller.BUTTON_RIGHT,
    'a': jsnes.Controller.BUTTON_A,
    'b': jsnes.Controller.BUTTON_B,
    'start': jsnes.Controller.BUTTON_START,
    'select': jsnes.Controller.BUTTON_SELECT
};

const UI_BUTTONS = [
    { label: "[ UP ]",  cmd: 'up',     tx: 3, ty: 16, cx: 0, cy: 2 },
    { label: "[LEFT]",  cmd: 'left',   tx: 1, ty: 16, cx: 8, cy: 4 },
    { label: "[RGHT]",  cmd: 'right',  tx: 4, ty: 16, cx: 8, cy: 4 },
    { label: "[DOWN]",  cmd: 'down',   tx: 3, ty: 16, cx: 0, cy: 6 },
    { label: "[ B ]",   cmd: 'b',      tx: 7, ty: 16, cx: 0, cy: 4 },
    { label: "[ A ]",   cmd: 'a',      tx: 9, ty: 16, cx: 0, cy: 4 },
    { label: "[ SEL ]", cmd: 'select', tx: 3, ty: 17, cx: 4, cy: 2 },
    { label: "[ STA ]", cmd: 'start',  tx: 5, ty: 17, cx: 4, cy: 2 }
];

function connect() {
    console.log(`Connecting to world: ${WORLD}...`);
    socket = new WebSocket(WS_URL, { origin: 'https://ourworldoftext.com' });

    socket.on('open', () => {
        console.log('Connected! Writing Controller UI...');
        setupControllerUI();
    });

    socket.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.kind === 'cmd') {
                const cmd = msg.data.toLowerCase().trim();
                if (CONTROLLER_MAP[cmd] !== undefined) {
                    nes.buttonDown(1, CONTROLLER_MAP[cmd]);
                    if (buttonTimers[cmd]) clearTimeout(buttonTimers[cmd]);
                    buttonTimers[cmd] = setTimeout(() => {
                        nes.buttonUp(1, CONTROLLER_MAP[cmd]);
                        delete buttonTimers[cmd];
                    }, 500);
                }
            }
        } catch (e) {}
    });

    socket.on('close', () => process.exit(1)); // GitHub action will restart if configured
}

function setupControllerUI() {
    const edits = [];
    const now = Date.now();
    UI_BUTTONS.forEach(btn => {
        btn.label.split('').forEach((char, i) => {
            const x = btn.cx + i;
            const fCX = x % TILE_C;
            const fTX = btn.tx + Math.floor(x / TILE_C);
            edits.push([btn.ty, fTX, btn.cy, fCX, now, char, nextEditId++, 0xFFFFFF, 0x333333]);
            socket.send(JSON.stringify({
                kind: 'link', type: 'url',
                data: { tileY: btn.ty, tileX: fTX, charY: btn.cy, charX: fCX, url: `comu:${btn.cmd}` }
            }));
        });
    });
    socket.send(JSON.stringify({ kind: 'write', edits }));
}

function renderToOWOT(frameBuffer) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const edits = [];
    const now = Date.now();
    for (let y = 0; y < HEIGHT; y += 2) {
        for (let x = 0; x < WIDTH; x++) {
            const idxT = y * WIDTH + x;
            const idxB = (y + 1) * WIDTH + x;
            const cellIdx = (y / 2) * WIDTH + x;
            const colorT = frameBuffer[idxT] & 0xFFFFFF;
            const colorB = frameBuffer[idxB] & 0xFFFFFF;
            const hash = (colorT << 24) ^ colorB;
            if (lastFrameData[cellIdx] !== hash) {
                edits.push([Math.floor((y/2)/TILE_R), Math.floor(x/TILE_C), (y/2)%TILE_R, x%TILE_C, now, "▀", nextEditId++, colorT, colorB]);
                lastFrameData[cellIdx] = hash;
            }
        }
    }
    if (edits.length > 0) {
        const BATCH = 400;
        for (let i = 0; i < edits.length; i += BATCH) {
            socket.send(JSON.stringify({ kind: 'write', edits: edits.slice(i, i + BATCH) }));
        }
    }
}

async function start() {
    const res = await fetch(ROM_URL);
    const romData = Buffer.from(await res.arrayBuffer()).toString('binary');
    nes.loadROM(romData);
    connect();
    setInterval(() => { nes.frame(); }, 1000 / 60);
}
start();
