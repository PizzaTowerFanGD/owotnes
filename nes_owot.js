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
let socket = null;
let nextEditId = 1;
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

const UI_PADS = [
    { label: "UP",    cmd: 'up',     tx: 3,  ty: 16 },
    { label: "LEFT",  cmd: 'left',   tx: 1,  ty: 17 },
    { label: "RIGHT", cmd: 'right',  tx: 5,  ty: 17 },
    { label: "DOWN",  cmd: 'down',   tx: 3,  ty: 18 },
    { label: "SEL",   cmd: 'select', tx: 8,  ty: 17 },
    { label: "START", cmd: 'start',  tx: 10, ty: 17 },
    { label: "B",     cmd: 'b',      tx: 13, ty: 17 },
    { label: "A",     cmd: 'a',      tx: 15, ty: 17 }
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function connect() {
    socket = new WebSocket(WS_URL, { origin: 'https://ourworldoftext.com' });

    socket.on('open', async () => {
        console.log('Connected! Staggering Big Pad Generation (1s per button)...');
        await setupControllerPads();
        console.log('Controller UI Complete.');
    });

    socket.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.kind === 'cmd') {
                const cmd = msg.data.toLowerCase().trim();
                handleButtonPress(cmd);
            }
        } catch (e) {}
    });

    socket.on('close', () => process.exit(1));
}

function handleButtonPress(cmd) {
    const buttonCode = CONTROLLER_MAP[cmd];
    if (buttonCode === undefined) return;

    nes.buttonDown(1, buttonCode);
    if (buttonTimers[cmd]) clearTimeout(buttonTimers[cmd]);
    
    // Hold button for 1/2 second
    buttonTimers[cmd] = setTimeout(() => {
        nes.buttonUp(1, buttonCode);
        delete buttonTimers[cmd];
    }, 500);
}

/**
 * Fixes Color mapping: Swap Red and Blue channels.
 */
function fixColor(c) {
    const r = c & 0xFF;
    const g = (c >> 8) & 0xFF;
    const b = (c >> 16) & 0xFF;
    return (r << 16) | (g << 8) | b;
}

/**
 * Creates pads one-by-one with a delay to prevent OWOT server packet loss.
 */
async function setupControllerPads() {
    for (const pad of UI_PADS) {
        console.log(`Setting up button: ${pad.label}...`);
        const edits = [];
        const now = Date.now();

        const startX = Math.floor((16 - pad.label.length) / 2);
        const startY = 3;

        for (let r = 0; r < TILE_R; r++) {
            for (let c = 0; c < TILE_C; c++) {
                let char = " ";
                if (r === startY && c >= startX && c < startX + pad.label.length) {
                    char = pad.label[c - startX];
                }

                // Visual edit
                edits.push([pad.ty, pad.tx, r, c, now, char, nextEditId++, 0xFFFFFF, 0x444444]);

                // Link packet
                socket.send(JSON.stringify({
                    kind: 'link',
                    type: 'url',
                    data: {
                        tileY: pad.ty, tileX: pad.tx,
                        charY: r, charX: c,
                        url: `comu:${pad.cmd}`
                    }
                }));
            }
        }
        
        // Write the visual part of this specific button
        socket.send(JSON.stringify({ kind: 'write', edits }));
        
        // Wait 1 second before doing the next button to let the server breathe
        await sleep(1000);
    }
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

            const colorT = fixColor(frameBuffer[idxT]);
            const colorB = fixColor(frameBuffer[idxB]);

            const hash = (colorT << 24) ^ colorB;
            if (lastFrameData[cellIdx] !== hash) {
                edits.push([
                    Math.floor((y / 2) / TILE_R), 
                    Math.floor(x / TILE_C),       
                    (y / 2) % TILE_R,             
                    x % TILE_C,                   
                    now, "▀", nextEditId++, colorT, colorB
                ]);
                lastFrameData[cellIdx] = hash;
            }
        }
    }

    if (edits.length > 0) {
        const BATCH = 450;
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
