const WebSocket = require('ws');
const jsnes = require('jsnes');
const fetch = require('node-fetch');

// --- Configuration ---
const WORLD = process.env.WORLD_NAME || 'owotness';
const MEMBER_KEY = process.env.MEMBER_KEY;
const ROM_URL = process.env.ROM_URL;
const WS_URL = `wss://ourworldoftext.com/${WORLD}/ws/${MEMBER_KEY ? '?key=' + MEMBER_KEY : ''}`;

const WIDTH = 256;
const HEIGHT = 240;
const TILE_C = 16; 
const TILE_R = 8;

let lastFrameData = new Uint32Array(WIDTH * (HEIGHT / 2));
let currentFrameBuffer = null;
let socket = null;
let nextEditId = 1;
let buttonTimers = {};
let interlaceField = 0; // 0 for even rows, 1 for odd rows

// --- NES Setup ---
const nes = new jsnes.NES({
    onFrame: (frameBuffer) => {
        currentFrameBuffer = new Uint32Array(frameBuffer);
    }
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

function connect() {
    socket = new WebSocket(WS_URL, { origin: 'https://ourworldoftext.com' });

    socket.on('open', () => {
        console.log('Connected to OWOT!');
        drawLabels();
        console.log('Interlaced 2 FPS Engine Active. Controls via Chat.');
    });

    socket.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.kind === 'chat') {
                const cmd = msg.message.toLowerCase().trim();
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

    socket.on('close', () => process.exit(1));
}

/**
 * Fixes BGR (NES) to RGB (OWOT)
 */
function fixColor(c) {
    const r = c & 0xFF;
    const g = (c >> 8) & 0xFF;
    const b = (c >> 16) & 0xFF;
    return (r << 16) | (g << 8) | b;
}

function drawLabels() {
    const text = "CHAT COMMANDS: UP, DOWN, LEFT, RIGHT, A, B, START, SELECT";
    const now = Date.now();
    const edits = text.split('').map((char, i) => [
        16, Math.floor(i / 16), 2, i % 16, now, char, nextEditId++, 0xFFFFFF, 0x000000
    ]);
    socket.send(JSON.stringify({ kind: 'write', edits }));
}

/**
 * Interlaced batch renderer.
 * One char '▀' = 2 vertical pixels. Total 120 char rows for 240 pixels.
 */
function renderInterlacedBatch() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !currentFrameBuffer) return;

    const fieldEdits = [];
    const now = Date.now();

    for (let yChar = 0; yChar < 120; yChar++) {
        // Only process rows matching the current interlace field (0 or 1)
        if (yChar % 2 !== interlaceField) continue;

        for (let x = 0; x < WIDTH; x++) {
            const idxTop = (yChar * 2) * WIDTH + x;
            const idxBot = (yChar * 2 + 1) * WIDTH + x;
            const cellIdx = yChar * WIDTH + x;

            const colorT = fixColor(currentFrameBuffer[idxTop]);
            const colorB = fixColor(currentFrameBuffer[idxBot]);
            const hash = (colorT << 24) ^ colorB;

            if (lastFrameData[cellIdx] !== hash) {
                fieldEdits.push([
                    Math.floor(yChar / TILE_R), Math.floor(x / TILE_C), // Tile Y, X
                    yChar % TILE_R, x % TILE_C,                         // Char Y, X
                    now, "▀", nextEditId++, colorT, colorB
                ]);
                lastFrameData[cellIdx] = hash;
            }
        }
    }

    // Switch field for the next 500ms cycle
    interlaceField = (interlaceField === 0) ? 1 : 0;

    if (fieldEdits.length > 0) {
        // Send in batches of 500 to prevent server throttling
        for (let i = 0; i < fieldEdits.length; i += 500) {
            socket.send(JSON.stringify({
                kind: 'write',
                edits: fieldEdits.slice(i, i + 500)
            }));
        }
    }
}

async function start() {
    const res = await fetch(ROM_URL);
    const romData = Buffer.from(await res.arrayBuffer()).toString('binary');
    nes.loadROM(romData);
    connect();

    // Game engine speed (60fps)
    setInterval(() => nes.frame(), 1000 / 60);

    // OWOT display speed (Interlaced 2fps)
    setInterval(() => renderInterlacedBatch(), 500); 
}

start().catch(console.error);
