/**
 * Easter egg — Space Invaders
 * Triggered by ⌥⇧A ⌥⇧T ⌥⇧A ⌥⇧R ⌥⇧I on the empty chat screen.
 * ESC to close.
 */
import { useEffect, useRef } from "react";

const W = 500;
const H = 300;

const COLS = 10;
const ROWS = 4;
const CELL_W = 42;
const CELL_H = 34;
const INV_PX = 3;       // pixel size for the bitmap
const INV_BW = 8 * INV_PX;
const INV_BH = 6 * INV_PX;

const GROUND_Y = H - 28;
const PLAYER_H = 12;
const PLAYER_W = 30;
const PLAYER_Y = GROUND_Y - PLAYER_H - 2;

const PLAYER_SPEED = 250;   // px/s
const BULLET_SPEED = 420;   // px/s
const INV_BULLET_SPEED = 170;
const BASE_INV_SPEED = 55;  // px/s, scales as invaders die

// Grid anchor (top-left of invader grid)
const GRID_X = (W - COLS * CELL_W) / 2 + INV_BW / 2;
const GRID_Y = 38;

// Invader pixel-art bitmap (8×6). Frame 1 wiggles the feet.
const FRAME0 = [
  [0,0,1,0,0,1,0,0],
  [0,1,1,1,1,1,1,0],
  [1,1,0,1,1,0,1,1],
  [1,1,1,1,1,1,1,1],
  [0,1,0,1,1,0,1,0],
  [1,0,1,0,0,1,0,1],
];
const FRAME1 = [
  [0,0,1,0,0,1,0,0],
  [0,1,1,1,1,1,1,0],
  [1,1,0,1,1,0,1,1],
  [1,1,1,1,1,1,1,1],
  [0,0,1,1,1,1,0,0],
  [0,1,0,0,0,0,1,0],
];

function drawInvader(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  color: string,
  frame: number,
) {
  ctx.fillStyle = color;
  const bm = frame === 0 ? FRAME0 : FRAME1;
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 8; c++) {
      if (bm[r][c]) {
        ctx.fillRect(cx - INV_BW / 2 + c * INV_PX, cy - INV_BH / 2 + r * INV_PX, INV_PX, INV_PX);
      }
    }
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, x: number) {
  ctx.fillStyle = "#4fb3d9";
  ctx.fillRect(x - PLAYER_W / 2, PLAYER_Y, PLAYER_W, PLAYER_H);
  ctx.fillRect(x - 4, PLAYER_Y - 8, 8, 8);
}

function drawExplosion(ctx: CanvasRenderingContext2D, x: number, t: number) {
  ctx.fillStyle = "#ff6b6b";
  const r = 14 * (1 - t);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.fillRect(x + Math.cos(a) * r - 3, PLAYER_Y + 6 + Math.sin(a) * r - 3, 6, 6);
  }
}

interface Invader { col: number; row: number; alive: boolean }
interface Bullet { x: number; y: number; player: boolean }

export default function SpaceInvaders({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const closeCb = useRef(onClose);
  closeCb.current = onClose;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    // ── State ────────────────────────────────────────────────────────────
    let playerX = W / 2;
    let bullets: Bullet[] = [];
    let invaders: Invader[] = [];
    let dirX = 1;
    let offsetX = 0;
    let offsetY = 0;
    let score = 0;
    let lives = 3;
    let shootCD = 0;
    let invShootT = 1.5;
    let animFrame = 0;
    let animT = 0;
    let phase: "playing" | "exploding" | "gameover" | "win" = "playing";
    let explodeT = 0;
    const keys: Record<string, boolean> = {};
    let raf = 0;
    let last = 0;

    for (let row = 0; row < ROWS; row++)
      for (let col = 0; col < COLS; col++)
        invaders.push({ col, row, alive: true });

    function ix(inv: Invader) { return GRID_X + inv.col * CELL_W + offsetX; }
    function iy(inv: Invader) { return GRID_Y + inv.row * CELL_H + offsetY; }
    function alive() { return invaders.filter(i => i.alive); }

    // ── Game loop ────────────────────────────────────────────────────────
    function loop(ts: number) {
      const dt = Math.min((ts - last) / 1000, 0.05);
      last = ts;

      ctx.fillStyle = "#050d1a";
      ctx.fillRect(0, 0, W, H);

      // Ground line
      ctx.fillStyle = "#1a3a5c";
      ctx.fillRect(0, GROUND_Y, W, 1);

      // HUD
      ctx.fillStyle = "#4fb3d9";
      ctx.font = "12px 'JetBrains Mono',monospace";
      ctx.textAlign = "left";
      ctx.fillText(`SCORE  ${String(score).padStart(5, "0")}`, 10, 20);
      ctx.textAlign = "right";
      ctx.fillText(`LIVES  ${"▮".repeat(lives)}`, W - 10, 20);

      // End screens
      if (phase === "gameover" || phase === "win") {
        const msg = phase === "win" ? "YOU WIN!" : "GAME OVER";
        ctx.fillStyle = phase === "win" ? "#4fb3d9" : "#ff6b6b";
        ctx.font = "bold 30px 'JetBrains Mono',monospace";
        ctx.textAlign = "center";
        ctx.fillText(msg, W / 2, H / 2 - 18);
        ctx.fillStyle = "#7a90a8";
        ctx.font = "13px 'JetBrains Mono',monospace";
        ctx.fillText(`Score: ${score}`, W / 2, H / 2 + 12);
        ctx.fillText("ESC to close", W / 2, H / 2 + 34);
        raf = requestAnimationFrame(loop);
        return;
      }

      // Explosion phase
      if (phase === "exploding") {
        explodeT += dt;
        drawExplosion(ctx, playerX, explodeT / 1.0);
        renderInvadersAndBullets();
        if (explodeT >= 1.0) {
          phase = lives > 0 ? "playing" : "gameover";
          playerX = W / 2;
          bullets = bullets.filter(b => !b.player);
          explodeT = 0;
        }
        raf = requestAnimationFrame(loop);
        return;
      }

      // ── Playing ──────────────────────────────────────────────────────
      // Player move
      if (keys["ArrowLeft"]) playerX = Math.max(PLAYER_W / 2, playerX - PLAYER_SPEED * dt);
      if (keys["ArrowRight"]) playerX = Math.min(W - PLAYER_W / 2, playerX + PLAYER_SPEED * dt);

      // Shoot
      shootCD -= dt;
      if (keys[" "] && shootCD <= 0) {
        bullets.push({ x: playerX, y: PLAYER_Y - 8, player: true });
        shootCD = 0.38;
      }

      // Invader move
      const liveInvaders = alive();
      const spd = (BASE_INV_SPEED + (ROWS * COLS - liveInvaders.length) * 4) * dt;
      offsetX += dirX * spd;

      // Wall bounce
      let minX = Infinity, maxX = -Infinity;
      for (const inv of liveInvaders) {
        const x = ix(inv);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
      if (maxX > W - INV_BW / 2 - 4 || minX < INV_BW / 2 + 4) {
        dirX *= -1;
        offsetY += 14;
      }

      // Invader shoot
      invShootT -= dt;
      if (invShootT <= 0 && liveInvaders.length > 0) {
        const s = liveInvaders[Math.floor(Math.random() * liveInvaders.length)];
        bullets.push({ x: ix(s), y: iy(s) + INV_BH / 2, player: false });
        invShootT = 0.5 + Math.random() * 1.6;
      }

      // Move bullets
      for (const b of bullets) {
        b.y += (b.player ? -BULLET_SPEED : INV_BULLET_SPEED) * dt;
      }

      // Player bullets hit invaders
      for (const b of bullets) {
        if (!b.player) continue;
        for (const inv of invaders) {
          if (!inv.alive) continue;
          if (Math.abs(b.x - ix(inv)) < INV_BW / 2 && Math.abs(b.y - iy(inv)) < INV_BH / 2) {
            inv.alive = false;
            b.y = -9999;
            score += (ROWS - inv.row + 1) * 10;
          }
        }
      }

      // Invader bullets hit player
      for (const b of bullets) {
        if (b.player) continue;
        if (
          b.y > PLAYER_Y &&
          b.y < PLAYER_Y + PLAYER_H &&
          Math.abs(b.x - playerX) < PLAYER_W / 2
        ) {
          b.y = 9999;
          lives--;
          phase = "exploding";
        }
      }

      // Remove out-of-bounds
      bullets = bullets.filter(b => b.y > -50 && b.y < H + 50);

      // Win / lose checks
      if (invaders.every(i => !i.alive)) { phase = "win"; }
      for (const inv of invaders) {
        if (inv.alive && iy(inv) + INV_BH / 2 >= GROUND_Y) {
          lives = 0; phase = "gameover";
        }
      }

      // Animate invaders
      animT += dt;
      if (animT > 0.45) { animFrame = 1 - animFrame; animT = 0; }

      renderInvadersAndBullets();
      drawPlayer(ctx, playerX);
      raf = requestAnimationFrame(loop);
    }

    function renderInvadersAndBullets() {
      for (const inv of invaders) {
        if (!inv.alive) continue;
        const rowColors = ["#ff6b6b", "#f8c555", "#4fb3d9", "#85e89d"];
        drawInvader(ctx, ix(inv), iy(inv), rowColors[inv.row] ?? "#4fb3d9", animFrame);
      }
      for (const b of bullets) {
        ctx.fillStyle = b.player ? "#4fb3d9" : "#ff6b6b";
        ctx.fillRect(b.x - 2, b.y, 3, 9);
      }
    }

    // ── Input ────────────────────────────────────────────────────────────
    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.key] = true;
      if (e.key === "Escape") { closeCb.current(); return; }
      if (["ArrowLeft","ArrowRight"," "].includes(e.key)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => { keys[e.key] = false; };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    canvas.focus();

    last = performance.now();
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H}
      tabIndex={0}
      className="rounded-xl outline-none"
      style={{ imageRendering: "pixelated", border: "1px solid #1a3a5c" }}
    />
  );
}
