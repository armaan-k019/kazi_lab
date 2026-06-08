"use client";

import { useEffect, useRef } from "react";

// A quiet, drifting point-field with faint lines between nearby points: a
// literal picture of what the lab studies (points that cluster and connect).
// Subtle by design. Static under prefers-reduced-motion, paused when hidden.

type Point = { x: number; y: number; vx: number; vy: number };

// Soft warm gray with a faint green tint, tuned to read as pencil-faint
// constellations on a white background.
const INK: [number, number, number] = [132, 138, 128];
const LINK_DISTANCE = 150; // px, threshold for drawing a connecting line
const POINT_COUNT_DIVISOR = 34000; // larger = fewer points; tuned to ~30-58

export function PointField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let points: Point[] = [];
    let frame = 0;

    const seed = (count: number) => {
      points = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        // slow drift
        vx: (Math.random() - 0.5) * 0.12,
        vy: (Math.random() - 0.5) * 0.12,
      }));
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = Math.round((width * height) / POINT_COUNT_DIVISOR);
      const count = Math.max(30, Math.min(58, target));
      seed(count);
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const [r, g, b] = INK;

      // Lines first, so points sit on top.
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          const dx = points[i].x - points[j].x;
          const dy = points[i].y - points[j].y;
          const dist = Math.hypot(dx, dy);
          if (dist < LINK_DISTANCE) {
            // Fade the line out as points separate. Max alpha ~0.07: a whisper
            // on white.
            const alpha = (1 - dist / LINK_DISTANCE) * 0.07;
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(points[i].x, points[i].y);
            ctx.lineTo(points[j].x, points[j].y);
            ctx.stroke();
          }
        }
      }

      for (const p of points) {
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.22)`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const step = () => {
      for (const p of points) {
        p.x += p.vx;
        p.y += p.vy;
        // wrap softly around the edges
        if (p.x < -10) p.x = width + 10;
        if (p.x > width + 10) p.x = -10;
        if (p.y < -10) p.y = height + 10;
        if (p.y > height + 10) p.y = -10;
      }
      draw();
      frame = requestAnimationFrame(step);
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    const start = () => {
      if (reduceMotion) {
        draw();
        return;
      }
      if (!frame) frame = requestAnimationFrame(step);
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    resize();
    start();

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0"
    />
  );
}
