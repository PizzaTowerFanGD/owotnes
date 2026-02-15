const WebSocket = require('ws');
const jsnes = require('jsnes');
const fetch = require('node-fetch');

// --- Configuration ---
let WORLD = process.env.WORLD_NAME || 'owotness';
const MEMBER_KEY = process.env.MEMBER_KEY;
let ROM_URL = process.env.ROM_URL;
const WS_URL = () => `wss://ourworldoftext.com/${WORLD}/ws/${MEMBER_KEY ? '?key=' + MEMBER_KEY : ''}`;

const WIDTH = 256;
const HEIGHT = 240;
const TILE_C = 16; 
const TILE_R = 8;

let lastFrameData = new Uint32Array(128 * 60);
let currentFrameBuffer = null;
let socket = null;
let nextEditId = 1;
let buttonTimers = {};
let interlaceField = 0; 
let hasAnnounced = false;

// --- Octant Mapping ---
const lcsOctantCharPoints = [
    4, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
    32, 33, 34, 35, 36, 37, 38, 39, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54,
    55, 56, 57, 58, 59, 60, 61, 62, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78,
    79, 81, 82, 83, 84, 86, 87, 88, 89, 91, 92, 93, 94, 96, 97, 98, 99, 100, 101, 102, 103,
    104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121,
    122, 123, 124, 125, 126, 127, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140,
    141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158,
    159, 161, 162, 163, 164, 166, 167, 168, 169, 171, 172, 173, 174, 176, 177, 178, 179, 180,
    181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 193, 194, 195, 196, 197, 198, 199,
    200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217,
    218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235,
    236, 237, 238, 239, 241, 242, 243, 244, 246, 247, 248, 249, 251, 253, 254
];
const octantCache = new Map();
lcsOctantCharPoints.forEach((bits, idx) => octantCache.set(bits, String.fromCodePoint(0x1CD00 + idx)));

// --- NES Logic ---
const nes = new jsnes.NES({
    onFrame: (frameBuffer) => { currentFrameBuffer = new Uint32Array(frameBuffer); }
});

const CONTROLLER_MAP = {
    'up': [jsnes.Controller.BUTTON_UP],
    'down': [jsnes.Controller.BUTTON_DOWN],
    'left': [jsnes.Controller.BUTTON_LEFT],
    'right': [jsnes.Controller.BUTTON_RIGHT],
    'a': [jsnes.Controller.BUTTON_A],
    'b': [jsnes.Controller.BUTTON_B],
    'start': [jsnes.Controller.BUTTON_START],
    'select': [jsnes.Controller.BUTTON_SELECT],
    'right+a': [jsnes.Controller.BUTTON_RIGHT, jsnes.Controller.BUTTON_A],
    'left+a': [jsnes.Controller.BUTTON_LEFT, jsnes.Controller.BUTTON_A]
};

function getGameName(url) {
    try {
        const parts = url.split('/');
        return parts[parts.length - 1].split('?')[0].replace(/\.nes$/i, '').replace(/%20|_/g, ' ');
    } catch(e) { return "a game"; }
}

function connect() {
    socket = new WebSocket(WS_URL(), { origin: 'https://ourworldoftext.com' });

    socket.on('open', () => {
        console.log('Connected to OWOT.');
        if (!hasAnnounced) {
            const gamename = getGameName(ROM_URL);
            // Global Announcement
            socket.send(JSON.stringify({
                kind: 'chat',
                nickname: 'RetroNESS',
                message: `the Retros have been activiated,. in /owotness. play ${gamename} the,re`,
                location: 'global',
                color: '#ff0000'
            }));
            hasAnnounced = true;
        }
    });

    socket.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.kind === 'chat') {
                const cmd = msg.message.trim().toLowerCase();
                if (msg.realUsername === 'gimmickCellar') {
                    if (cmd.startsWith('setrom ')) {
                        ROM_URL = msg.message.split(' ')[1];
                        return await start();
                    }
                    if (cmd === 'quit') process.exit(0);
                    if (cmd === 'reset') nes.reset();
                }
                if (CONTROLLER_MAP[cmd]) {
                    CONTROLLER_MAP[cmd].forEach(b => nes.buttonDown(1, b));
                    if (buttonTimers[cmd]) clearTimeout(buttonTimers[cmd]);
                    buttonTimers[cmd] = setTimeout(() => {
                        CONTROLLER_MAP[cmd].forEach(b => nes.buttonUp(1, b));
                    }, 500);
                }
            }
        } catch (e) {}
    });

    socket.on('close', () => setTimeout(connect, 2000));
}

function fixColor(c) {
    // Corrects JSNES BGR to OWOT RGB
    const r = c & 0xFF;
    const g = (c >> 8) & 0xFF;
    const b = (c >> 16) & 0xFF;
    return (r << 16) | (g << 8) | b;
}

function renderInterlacedOctants() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !currentFrameBuffer) return;
    const edits = [];
    const now = Date.now();

    for (let yChar = 0; yChar < 60; yChar++) {
        if (yChar % 2 !== interlaceField) continue;
        for (let xChar = 0; xChar < 128; xChar++) {
            let bitmask = 0;
            let pixels = [];
            for (let sy = 0; sy < 4; sy++) {
                for (let sx = 0; sx < 2; sx++) {
                    pixels.push(fixColor(currentFrameBuffer[(yChar * 4 + sy) * WIDTH + (xChar * 2 + sx)]));
                }
            }
            const counts = {};
            pixels.forEach(p => counts[p] = (counts[p] || 0) + 1);
            const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
            const fg = parseInt(sorted[0]);
            const bg = sorted[1] ? parseInt(sorted[1]) : fg;
            [1, 2, 4, 8, 16, 32, 64, 128].forEach((bit, i) => { if (pixels[i] === fg) bitmask |= bit; });

            const char = octantCache.get(bitmask) || " ";
            const hash = (fg << 16) ^ (bg << 8) ^ bitmask;
            const cellIdx = yChar * 128 + xChar;

            if (lastFrameData[cellIdx] !== hash) {
                edits.push([Math.floor(yChar/TILE_R), Math.floor(xChar/TILE_C), yChar%TILE_R, xChar%TILE_C, now, char, nextEditId++, fg, bg]);
                lastFrameData[cellIdx] = hash;
            }
        }
    }
    interlaceField = (interlaceField === 0) ? 1 : 0;
    if (edits.length > 0) {
        for (let i = 0; i < edits.length; i += 450) {
            socket.send(JSON.stringify({ kind: 'write', edits: edits.slice(i, i + 450) }));
        }
    }
}

async function start() {
    const res = await fetch(ROM_URL);
    const romData = Buffer.from(await res.arrayBuffer()).toString('binary');
    nes.loadROM(romData);
    if (!socket) connect();
    if (global.lInt) clearInterval(global.lInt);
    global.lInt = setInterval(() => nes.frame(), 1000 / 60);
    if (global.rInt) clearInterval(global.rInt);
    global.rInt = setInterval(() => renderInterlacedOctants(), 500);
}

start().catch(console.error);
