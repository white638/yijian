import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Maximize2,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import {
  itemName,
  type Item,
  type OutfitLayout,
  type OutfitPlacement,
} from "../types";
import { clamp, placementStyle } from "../outfit-layout";
import { Button, Field, Garment } from "./UI";

const normalizeRotation = (angle: number) =>
  ((((angle + 180) % 360) + 360) % 360) - 180;
type InteractionMode = "move" | "resize" | "rotate";

export function OutfitCanvas({
  layout,
  items,
  onChange,
  onRemove,
}: {
  layout: OutfitLayout;
  items: Item[];
  onChange: (layout: OutfitLayout) => void;
  onRemove: (id: string) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const help = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 400, height: 500 });
  const drag = useRef<{
    mode: InteractionMode;
    pointerId: number;
    placement: OutfitPlacement;
    startX: number;
    startY: number;
    canvasWidth: number;
    canvasHeight: number;
    centerX: number;
    centerY: number;
    distance: number;
    angle: number;
  } | null>(null);
  const active = layout.placements.find((p) => p.item_id === selected);
  const activeItem = items.find((i) => i.id === active?.item_id);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height)
        setCanvasSize((previous) =>
          previous.width === rect.width && previous.height === rect.height
            ? previous
            : { width: rect.width, height: rect.height },
        );
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  useEffect(() => {
    if (
      drag.current &&
      !layout.placements.some(
        (p) => p.item_id === drag.current?.placement.item_id,
      )
    )
      drag.current = null;
  }, [layout.placements]);
  function update(id: string, patch: Partial<OutfitPlacement>) {
    onChange({
      ...layout,
      placements: layout.placements.map((p) =>
        p.item_id === id ? { ...p, ...patch } : p,
      ),
    });
  }
  function layer(front: boolean) {
    if (!active) return;
    const rest = layout.placements.filter((p) => p.item_id !== active.item_id);
    onChange({
      ...layout,
      placements: front ? [...rest, active] : [active, ...rest],
    });
  }
  function startInteraction(
    e: PointerEvent<HTMLButtonElement>,
    p: OutfitPlacement,
    mode: InteractionMode,
  ) {
    if (e.button !== 0 || drag.current || e.currentTarget.matches(":disabled"))
      return;
    const rect = stage.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    e.stopPropagation();
    setSelected(p.item_id);
    const centerX = rect.left + (p.x / 100) * rect.width;
    const centerY = rect.top + (p.y / 100) * rect.height;
    drag.current = {
      mode,
      pointerId: e.pointerId,
      placement: { ...p },
      startX: e.clientX,
      startY: e.clientY,
      canvasWidth: rect.width,
      canvasHeight: rect.height,
      centerX,
      centerY,
      distance: Math.max(
        1,
        Math.hypot(e.clientX - centerX, e.clientY - centerY),
      ),
      angle: Math.atan2(e.clientY - centerY, e.clientX - centerX),
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function moveInteraction(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (
      !d ||
      d.pointerId !== e.pointerId ||
      e.currentTarget.matches(":disabled")
    )
      return;
    const p = d.placement;
    if (d.mode === "move") {
      update(p.item_id, {
        x: clamp(p.x + ((e.clientX - d.startX) / d.canvasWidth) * 100, 0, 100),
        y: clamp(p.y + ((e.clientY - d.startY) / d.canvasHeight) * 100, 0, 100),
      });
    } else if (d.mode === "resize") {
      const distance = Math.hypot(e.clientX - d.centerX, e.clientY - d.centerY);
      update(p.item_id, {
        width: clamp((p.width * distance) / d.distance, 8, 85),
      });
    } else {
      const angle = Math.atan2(e.clientY - d.centerY, e.clientX - d.centerX);
      update(p.item_id, {
        rotation: normalizeRotation(
          p.rotation + ((angle - d.angle) * 180) / Math.PI,
        ),
      });
    }
  }
  function endInteraction(e: PointerEvent<HTMLButtonElement>) {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function handlePositions(p: OutfitPlacement) {
    const radians = (p.rotation * Math.PI) / 180;
    const { width, height } = canvasSize;
    const half = (p.width * width) / 200;
    const center = { x: (p.x * width) / 100, y: (p.y * height) / 100 };
    const inset = ({ x, y }: { x: number; y: number }) => ({
      x: clamp(x, 22, width - 22),
      y: clamp(y, 22, height - 22),
    });
    const resize = inset({
      x: center.x + half * (Math.cos(radians) - Math.sin(radians)),
      y: center.y + half * (Math.sin(radians) + Math.cos(radians)),
    });
    let rotate = inset({
      x: center.x + (half + 22) * Math.sin(radians),
      y: center.y - (half + 22) * Math.cos(radians),
    });
    if (
      Math.abs(rotate.x - resize.x) < 48 &&
      Math.abs(rotate.y - resize.y) < 48
    ) {
      const options = [
        [-48, 0],
        [48, 0],
        [0, -48],
        [0, 48],
      ]
        .map(([dx, dy]) => ({ x: resize.x + dx, y: resize.y + dy }))
        .filter(
          (point) =>
            point.x >= 22 &&
            point.x <= width - 22 &&
            point.y >= 22 &&
            point.y <= height - 22,
        )
        .sort(
          (a, b) =>
            Math.hypot(a.x - rotate.x, a.y - rotate.y) -
            Math.hypot(b.x - rotate.x, b.y - rotate.y),
        );
      if (options.length) rotate = options[0];
    }
    return { resize, rotate };
  }
  const handles = active ? handlePositions(active) : null;
  return (
    <div className="studio-canvas-tools">
      <div
        ref={stage}
        className="outfit-canvas"
        style={{ background: layout.background }}
        role="group"
        aria-label="穿搭画布"
      >
        {!layout.placements.length && (
          <p className="canvas-empty">从衣柜挑选单品，开始你的搭配</p>
        )}
        {layout.placements.map((p) => {
          const item = items.find((i) => i.id === p.item_id);
          if (!item) return null;
          return (
            <button
              key={p.item_id}
              type="button"
              className={`canvas-piece ${selected === p.item_id ? "selected" : ""}`}
              style={placementStyle(p)}
              aria-label={`调整${itemName(item)}`}
              aria-pressed={selected === p.item_id}
              aria-describedby={help}
              onClick={() => setSelected(p.item_id)}
              onPointerDown={(e) => startInteraction(e, p, "move")}
              onPointerMove={moveInteraction}
              onPointerUp={endInteraction}
              onPointerCancel={endInteraction}
              onLostPointerCapture={endInteraction}
              onKeyDown={(e) => {
                const delta: Record<string, [number, number]> = {
                  ArrowLeft: [-1, 0],
                  ArrowRight: [1, 0],
                  ArrowUp: [0, -1],
                  ArrowDown: [0, 1],
                };
                const direction = delta[e.key];
                if (!direction) return;
                e.preventDefault();
                setSelected(p.item_id);
                const step = e.shiftKey ? 10 : 2;
                update(p.item_id, {
                  x: clamp(p.x + direction[0] * step, 0, 100),
                  y: clamp(p.y + direction[1] * step, 0, 100),
                });
              }}
            >
              <Garment item={item} />
            </button>
          );
        })}
        {active && activeItem && handles && (
          <>
            <div
              className="canvas-selection"
              style={placementStyle(active)}
              aria-hidden="true"
            />
            {(["resize", "rotate"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={`canvas-handle ${kind}`}
                style={{ left: handles[kind].x, top: handles[kind].y }}
                aria-label={`${kind === "resize" ? "缩放" : "旋转"}${itemName(activeItem)}`}
                aria-describedby={help}
                title={
                  kind === "resize"
                    ? "拖动缩放，方向键微调大小"
                    : "拖动旋转，方向键微调角度"
                }
                onPointerDown={(e) => startInteraction(e, active, kind)}
                onPointerMove={moveInteraction}
                onPointerUp={endInteraction}
                onPointerCancel={endInteraction}
                onLostPointerCapture={endInteraction}
                onKeyDown={(e) => {
                  const direction = ["ArrowRight", "ArrowUp"].includes(e.key)
                    ? 1
                    : ["ArrowLeft", "ArrowDown"].includes(e.key)
                      ? -1
                      : 0;
                  if (!direction || e.currentTarget.matches(":disabled"))
                    return;
                  e.preventDefault();
                  if (kind === "resize")
                    update(active.item_id, {
                      width: clamp(
                        active.width + direction * (e.shiftKey ? 5 : 1),
                        8,
                        85,
                      ),
                    });
                  else
                    update(active.item_id, {
                      rotation: normalizeRotation(
                        active.rotation + direction * (e.shiftKey ? 15 : 5),
                      ),
                    });
                }}
              >
                {kind === "resize" ? (
                  <Maximize2 size={16} aria-hidden="true" />
                ) : (
                  <RotateCw size={17} aria-hidden="true" />
                )}
              </button>
            ))}
          </>
        )}
      </div>
      <p className="small muted" id={help}>
        拖动单品移动，拖右下角缩放、顶部手柄旋转。单品与手柄均可用方向键微调，按住
        Shift 加快。
      </p>
      {active && activeItem ? (
        <section className="piece-controls" aria-label="选中单品调整">
          <strong>{itemName(activeItem)}</strong>
          <div className="form-grid">
            <Field label={`大小 ${Math.round(active.width)}%`}>
              <input
                aria-label="单品大小"
                type="range"
                min="8"
                max="85"
                step="1"
                value={active.width}
                onChange={(e) =>
                  update(active.item_id, { width: Number(e.target.value) })
                }
              />
            </Field>
            <Field label={`旋转 ${Math.round(active.rotation)}°`}>
              <input
                aria-label="单品旋转"
                type="range"
                min="-180"
                max="180"
                step="1"
                value={active.rotation}
                onChange={(e) =>
                  update(active.item_id, { rotation: Number(e.target.value) })
                }
              />
            </Field>
          </div>
          <div className="row wrap">
            <Button kind="secondary" onClick={() => layer(true)}>
              <ArrowUpToLine size={15} />
              移到最前
            </Button>
            <Button kind="secondary" onClick={() => layer(false)}>
              <ArrowDownToLine size={15} />
              移到最后
            </Button>
            <Button
              kind="ghost"
              onClick={() => update(active.item_id, { rotation: 0 })}
            >
              <RotateCcw size={15} />
              摆正
            </Button>
            <Button kind="ghost" onClick={() => onRemove(active.item_id)}>
              <X size={15} />
              移出搭配
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
