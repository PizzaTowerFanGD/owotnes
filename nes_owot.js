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
        drawUIBatch();
        console.log('2 FPS Engine Started. Use chat to control.');
    });

    socket.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            // Controls via Chat
            if (msg.kind === 'chat') {
                const cmd = msg.message.toLowerCase().trim();
                if (CONTROLLER_MAP[cmd] !== undefined) {
                    handleInput(cmd);
                }
            }
        } catch (e) {}
    });

    socket.on('close', () => process.exit(1));
}

function handleInput(cmd) {
    const buttonCode = CONTROLLER_MAP[cmd];
    nes.buttonDown(1, buttonCode);
    if (buttonTimers[cmd]) clearTimeout(buttonTimers[cmd]);
    buttonTimers[cmd] = setTimeout(() => {
        nes.buttonUp(1, buttonCode);
        delete buttonTimers[cmd];
    }, 500); // 1/2 second hold
}

/**
 * Corrects BGR (JSNES) to RGB (OWOT)
 */
function fixColor(c) {
    const r = c & 0xFF;
    const g = (c >> 8) & 0xFF;
    const b = (c >> 16) & 0xFF;
    return (r << 16) | (g << 8) | b;
}

/**
 * Draws the instructional labels in one single batch edit
 */
function drawUIBatch() {
    const labels = [
        { l: "TYPE 'UP'", x: 48, y: 128 }, { l: "TYPE 'DOWN'", x: 48, y: 144 },
        { l: "TYPE 'LEFT'", x: 16, y: 136 }, { l: "TYPE 'RIGHT'", x: 80, y: 136 },
        { l: "TYPE 'B'", x: 160, y: 136 }, { l: "TYPE 'A'", x: 200, y: 136 },
        { l: "TYPE 'START'", x: 110, y: 145 }, { l: "TYPE 'SELECT'", x: 110, y: 130 }
    ];

    const edits = [];
    const now = Date.now();

    labels.forEach(btn => {
        btn.l.split('').forEach((char, i) => {
            const posX = btn.x + i;
            const posY = btn.y;
            edits.push([
                Math.floor(posY / TILE_R), Math.floor(posX / TILE_C), // Tile Y, X
                posY % TILE_R, posX % TILE_C,                        // Char Y, X
                now, char, nextEditId++, 0xFFFFFF, 0x333333
            ]);
        });
    });

    socket.send(JSON.stringify({ kind: 'write', edits }));
}

/**
 * Core Render Logic: Compiles every change into one giant batch
 * then slices it into network-safe packets.
 */
function renderToOWOTBatch() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !currentFrameBuffer) return;

    const allEdits = [];
    const now = Date.now();

    for (let y = 0; y < HEIGHT; y += 2) {
        for (let x = 0; x < WIDTH; x++) {
            const idxT = y * WIDTH + x;
            const idxB = (y + 1) * WIDTH + x;
            const cellIdx = (y / 2) * WIDTH + x;

            const colorT = fixColor(currentFrameBuffer[idxT]);
            const colorB = fixColor(currentFrameBuffer[idxB]);
            const hash = (colorT << 24) ^ colorB;

            if (lastFrameData[cellIdx] !== hash) {
                allEdits.push([
                    Math.floor((y / 2) / TILE_R), Math.floor(x / TILE_C), // Tile Y, X
                    (y / 2) % TILE_R, x % TILE_C,                         // Char Y, X
                    now, "▀", nextEditId++, colorT, colorB
                ]);
                lastFrameData[cellIdx] = hash;
            }
        }
    }

    // Process the compiled batch in chunks of 500
    if (allEdits.length > 0) {
        const CHUNK_SIZE = 500;
        for (let i = 0; i < allEdits.length; i += CHUNK_SIZE) {
            socket.send(JSON.stringify({
                kind: 'write',
                edits: allEdits.slice(i, i + CHUNK_SIZE)
            }));
        }
    }
}

async function start() {
    const res = await fetch(ROM_URL);
    const romData = Buffer.from(await res.arrayBuffer()).toString('binary');
    nes.loadROM(romData);
    connect();

    // Emulator Logic Loop (60 FPS)
    setInterval(() => { nes.frame(); }, 1000 / 60);

    // OWOT Casting Loop (2 FPS)
    setInterval(() => { renderToOWOTBatch(); }, 500); 
}

start().catch(console.error);
