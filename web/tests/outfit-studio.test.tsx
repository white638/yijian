import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AppProvider } from "../src/Store";
import { Collage } from "../src/components/UI";
import { ItemPicker, OutfitEditor } from "../src/components/Outfits";
import { templatePlacements } from "../src/outfit-layout";
import type { AppState, Outfit, OutfitLayout } from "../src/types";
import { fixture, shirt } from "./fixtures";
const mocks = vi.hoisted(() => ({ send: vi.fn(), refresh: vi.fn() }));
vi.mock("../src/api", () => ({
  api: vi.fn(),
  send: mocks.send,
  failure: (e: Error) => e.message,
}));
function mount(children: ReactNode, state = fixture()) {
  return render(
    <AppProvider
      value={{
        state,
        refresh: mocks.refresh,
        notify: vi.fn(),
        openItem: vi.fn(),
        openAdd: vi.fn(),
        openOutfit: vi.fn(),
        openPlan: vi.fn(),
        navigate: vi.fn(),
      }}
    >
      {children}
    </AppProvider>,
  );
}
const ids = ["top", "bottom", "shoes"];
function saved(layout?: OutfitLayout): Outfit {
  return {
    id: "look",
    name: "我的通勤",
    item_ids: ids,
    notes: "",
    source: "manual",
    created_at: "2026-09-09T00:00:00Z",
    layout,
  };
}
const mode = (name: string) =>
  within(screen.getByRole("group", { name: "创建穿搭方式" })).getByRole(
    "button",
    { name: new RegExp(name) },
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it("persists keyboard movement, size, rotation, background and layer order and restores them when reopened", async () => {
  const view = mount(<OutfitEditor outfit={saved()} onClose={vi.fn()} />);
  const piece = screen.getByRole("button", { name: "调整白色衬衫" });
  const start = parseFloat(piece.style.left);
  fireEvent.keyDown(piece, { key: "ArrowRight" });
  expect(parseFloat(piece.style.left)).toBe(start + 2);
  fireEvent.change(screen.getByRole("slider", { name: "单品大小" }), {
    target: { value: "43" },
  });
  fireEvent.change(screen.getByRole("slider", { name: "单品旋转" }), {
    target: { value: "30" },
  });
  fireEvent.click(screen.getByRole("button", { name: "移到最前" }));
  fireEvent.click(screen.getByRole("button", { name: "米色" }));
  fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  const payload = mocks.send.mock.calls[0][1];
  expect(payload.item_ids).toEqual(ids);
  expect(payload.layout).toMatchObject({
    version: 1,
    mode: "free",
    background: "#f5f2ec",
  });
  expect(
    payload.layout.placements.map((p: { item_id: string }) => p.item_id),
  ).toEqual(["bottom", "shoes", "top"]);
  expect(payload.layout.placements[2]).toMatchObject({
    x: start + 2,
    width: 43,
    rotation: 30,
  });
  view.unmount();
  mount(<OutfitEditor outfit={saved(payload.layout)} onClose={vi.fn()} />);
  const reopened = screen.getByRole("button", { name: "调整白色衬衫" });
  expect(reopened).toHaveStyle({
    left: `${start + 2}%`,
    width: "43%",
    transform: "translate(-50%, -50%) rotate(30deg)",
  });
  expect(screen.getByRole("group", { name: "穿搭画布" })).toHaveStyle({
    background: "#f5f2ec",
  });
});

it("moves a garment using pointer deltas relative to the actual canvas and stops on release", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  mount(<OutfitEditor outfit={saved()} onClose={vi.fn()} />);
  const canvas = screen.getByRole("group", { name: "穿搭画布" });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    width: 400,
    height: 500,
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 500,
    toJSON: () => ({}),
  });
  const piece = screen.getByRole("button", { name: "调整白色衬衫" });
  const x = parseFloat(piece.style.left),
    y = parseFloat(piece.style.top);
  fireEvent.pointerDown(piece, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(piece, { clientX: 140, clientY: 150 });
  expect(parseFloat(piece.style.left)).toBe(x + 10);
  expect(parseFloat(piece.style.top)).toBe(y + 10);
  fireEvent.pointerUp(piece);
  fireEvent.pointerMove(piece, { clientX: 300, clientY: 300 });
  expect(parseFloat(piece.style.left)).toBe(x + 10);
});

it("keeps selected IDs across all modes, filters bags by category and applies an editable template", async () => {
  const state = fixture();
  state.items.push({ ...shirt, id: "bag", name: "通勤包", category: "bag" });
  mount(<OutfitEditor outfit={saved()} onClose={vi.fn()} />, state);
  fireEvent.click(mode("按类别"));
  fireEvent.click(
    within(screen.getByRole("group", { name: "筛选衣物类别" })).getByRole(
      "button",
      { name: /包袋/ },
    ),
  );
  const picker = screen.getByRole("region", { name: "搭配衣柜" });
  expect(
    within(picker).queryByRole("button", { name: "白色衬衫" }),
  ).not.toBeInTheDocument();
  fireEvent.click(within(picker).getByRole("button", { name: "通勤包" }));
  fireEvent.click(mode("拼图"));
  fireEvent.click(screen.getByRole("button", { name: "网格" }));
  fireEvent.click(screen.getByRole("button", { name: "杂志" }));
  fireEvent.click(mode("AI 推荐"));
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(mode("自由拖动"));
  expect(
    screen.getByRole("group", { name: "搭配全部单品（4 件）" }),
  ).toHaveTextContent("通勤包");
  fireEvent.click(screen.getByRole("button", { name: "调整通勤包" }));
  fireEvent.change(screen.getByRole("slider", { name: "单品旋转" }), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  const payload = mocks.send.mock.calls[0][1];
  expect(payload.item_ids).toEqual([...ids, "bag"]);
  expect(payload.layout.template).toBe("editorial");
  expect(
    payload.layout.placements.find(
      (p: { item_id: string }) => p.item_id === "bag",
    ).rotation,
  ).toBe(12);
});

it("removes a garment from both membership and layout without losing the remaining custom transforms", async () => {
  mount(<OutfitEditor outfit={saved()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "调整白色衬衫" }));
  fireEvent.change(screen.getByRole("slider", { name: "单品旋转" }), {
    target: { value: "17" },
  });
  fireEvent.click(screen.getByRole("button", { name: "从搭配移除蓝色长裤" }));
  fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  const payload = mocks.send.mock.calls[0][1];
  expect(payload.item_ids).toEqual(["top", "shoes"]);
  expect(
    payload.layout.placements.map((p: { item_id: string }) => p.item_id).sort(),
  ).toEqual(["shoes", "top"]);
  expect(
    payload.layout.placements.find(
      (p: { item_id: string }) => p.item_id === "top",
    ).rotation,
  ).toBe(17);
});

it.each(["openai", "compatible", "ollama", "codex", "none"] as const)(
  "uses the real %s recommendation path only after a click and preserves its source when editing layout",
  async (provider) => {
    const state = fixture();
    state.ai.provider = provider;
    state.ai.capabilities.text = provider !== "none";
    const apiAI = ["openai", "compatible", "ollama"].includes(provider);
    const source = apiAI ? "ai" : "rules";
    mocks.send.mockResolvedValueOnce({
      outfits: [
        { name: "适合今天", item_ids: ids, source, reason: "适合当前气温" },
      ],
      missing: [],
      message: "",
    });
    mount(<OutfitEditor onClose={vi.fn()} />, state);
    fireEvent.click(mode("AI 推荐"));
    expect(mocks.send).not.toHaveBeenCalled();
    if (provider === "codex")
      expect(screen.getByText(/Codex 中运行 \$yijian/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: apiAI ? "生成 AI 推荐" : "生成规则推荐",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "选用并编辑" }),
      ).toBeInTheDocument(),
    );
    expect(mocks.send).toHaveBeenCalledWith(
      apiAI ? "/ai/recommend" : "/recommendations",
      expect.objectContaining({
        locked_ids: [],
        temperature: 22,
        occasion: "casual",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "选用并编辑" }));
    expect(mode("自由拖动")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "调整白色衬衫" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "调整白色衬衫" }), {
      key: "ArrowDown",
    });
    fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenLastCalledWith(
        "/outfits",
        expect.objectContaining({
          source,
          item_ids: ids,
          layout: expect.objectContaining({ mode: "free" }),
        }),
        "POST",
      ),
    );
  },
);

it("renders saved layout coordinates and all eight thumbnails instead of truncating the saved canvas", () => {
  const state = fixture();
  const items = Array.from({ length: 8 }, (_, index) => ({
    ...shirt,
    id: String(index),
    name: `单品${index}`,
    image_url: `/api/images/${index}.jpg`,
  }));
  const chosen = items.map((i) => i.id);
  const layout: OutfitLayout = {
    version: 1,
    mode: "collage",
    template: "grid",
    background: "#eceef5",
    placements: templatePlacements(chosen, items, "grid"),
  };
  render(<Collage ids={chosen} items={items} layout={layout} />);
  expect(screen.getAllByRole("img")).toHaveLength(8);
  const p = layout.placements[7];
  expect(
    screen.getByRole("img", { name: "单品7" }).parentElement?.parentElement,
  ).toHaveStyle({ left: `${p.x}%`, top: `${p.y}%`, width: `${p.width}%` });
});

it("enforces the 24 garment editing limit while allowing removal", () => {
  const state = fixture();
  state.items = Array.from({ length: 25 }, (_, index) => ({
    ...shirt,
    id: String(index),
    name: `单品${index}`,
  }));
  const change = vi.fn();
  mount(
    <ItemPicker
      selected={state.items.slice(0, 24).map((i) => i.id)}
      onChange={change}
      limit={24}
    />,
    state,
  );
  expect(screen.getByRole("button", { name: "单品24" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "单品0" }));
  expect(change.mock.calls[0][0]).toHaveLength(23);
});

it.each(["balanced", "grid", "editorial"] as const)(
  "keeps the %s template within persistence bounds for 24 items",
  (template) => {
    const items = Array.from({ length: 24 }, (_, index) => ({
      ...shirt,
      id: String(index),
    }));
    const placements = templatePlacements(
      items.map((i) => i.id),
      items,
      template,
    );
    expect(new Set(placements.map((p) => p.item_id)).size).toBe(24);
    for (const p of placements) {
      expect(p.width).toBeGreaterThanOrEqual(8);
      expect(p.width).toBeLessThanOrEqual(85);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(100);
    }
  },
);

it.each(["success", "failure"] as const)(
  "locks every editing control while save is pending and handles %s without losing draft changes",
  async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    mocks.send.mockReturnValueOnce(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const close = vi.fn();
    mount(<OutfitEditor outfit={saved()} onClose={close} />);
    fireEvent.click(mode("拼图"));
    const piece = screen.getByRole("button", { name: "调整白色衬衫" });
    fireEvent.click(piece);
    fireEvent.change(screen.getByLabelText("搭配名称"), {
      target: { value: "保存前名称" },
    });
    fireEvent.change(screen.getByLabelText("搭配笔记"), {
      target: { value: "保存前笔记" },
    });
    const start = piece.style.left;
    fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
    for (const control of [
      piece,
      mode("自由拖动"),
      mode("AI 推荐"),
      screen.getByRole("button", { name: "网格" }),
      screen.getByRole("button", { name: "白色衬衫" }),
      screen.getByRole("slider", { name: "单品旋转" }),
      screen.getByRole("button", { name: "缩放白色衬衫" }),
      screen.getByRole("button", { name: "旋转白色衬衫" }),
      screen.getByLabelText("搭配名称"),
      screen.getByLabelText("搭配笔记"),
      screen.getByRole("button", { name: "关闭" }),
    ])
      expect(control).toBeDisabled();
    fireEvent.keyDown(piece, { key: "ArrowRight" });
    const width = piece.style.width;
    fireEvent.keyDown(screen.getByRole("button", { name: "缩放白色衬衫" }), {
      key: "ArrowRight",
    });
    expect(piece.style.width).toBe(width);
    fireEvent.change(screen.getByLabelText("搭配名称"), {
      target: { value: "不能写入" },
    });
    fireEvent.click(mode("自由拖动"));
    expect(piece.style.left).toBe(start);
    expect(mode("拼图")).toHaveAttribute("aria-pressed", "true");
    expect(mocks.send.mock.calls[0][1]).toMatchObject({
      name: "保存前名称",
      notes: "保存前笔记",
    });
    expect(mocks.send).toHaveBeenCalledOnce();
    if (outcome === "success") {
      resolve({});
      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(mocks.refresh).toHaveBeenCalledOnce();
    } else {
      reject(new Error("暂时无法保存"));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("暂时无法保存"),
      );
      expect(close).not.toHaveBeenCalled();
      expect(piece).toBeEnabled();
      expect(screen.getByLabelText("搭配名称")).toHaveValue("保存前名称");
      expect(screen.getByLabelText("搭配笔记")).toHaveValue("保存前笔记");
      fireEvent.change(screen.getByLabelText("搭配名称"), {
        target: { value: "继续编辑" },
      });
      expect(screen.getByLabelText("搭配名称")).toHaveValue("继续编辑");
    }
  },
);

function mountHandleCanvas(rotation = 0, position = { x: 50, y: 50 }) {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(
      type: string,
      init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
    ) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  const layout: OutfitLayout = {
    version: 1,
    mode: "free",
    template: "grid",
    background: "#f5f2ec",
    placements: [{ item_id: "top", ...position, width: 40, rotation }],
  };
  mount(
    <OutfitEditor
      outfit={{ ...saved(layout), item_ids: ["top"] }}
      onClose={vi.fn()}
    />,
  );
  const canvas = screen.getByRole("group", { name: "穿搭画布" });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    width: 400,
    height: 500,
    left: 20,
    top: 30,
    x: 20,
    y: 30,
    right: 420,
    bottom: 530,
    toJSON: () => ({}),
  });
  const piece = screen.getByRole("button", { name: "调整白色衬衫" });
  fireEvent.click(piece);
  return {
    canvas,
    piece,
    resize: screen.getByRole("button", { name: "缩放白色衬衫" }),
    rotate: screen.getByRole("button", { name: "旋转白色衬衫" }),
  };
}

it.each(["mouse", "touch"])(
  "resizes the rotated square around its center with a %s pointer and saves the result",
  async (pointerType) => {
    const { canvas, piece, resize } = mountHandleCanvas(30);
    const radians = Math.PI / 6;
    const dx = 80 * (Math.cos(radians) - Math.sin(radians));
    const dy = 80 * (Math.sin(radians) + Math.cos(radians));
    const capture = vi.fn(),
      release = vi.fn();
    Object.assign(resize, {
      setPointerCapture: capture,
      hasPointerCapture: () => true,
      releasePointerCapture: release,
    });
    fireEvent.pointerDown(resize, {
      pointerId: 7,
      pointerType,
      button: 0,
      clientX: 220 + dx,
      clientY: 280 + dy,
    });
    expect(capture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(resize, {
      pointerId: 7,
      pointerType,
      clientX: 220 + dx * 1.5,
      clientY: 280 + dy * 1.5,
    });
    expect(parseFloat(piece.style.width)).toBeCloseTo(60);
    expect(piece).toHaveStyle({
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%) rotate(30deg)",
    });
    fireEvent.pointerUp(resize, { pointerId: 7, pointerType });
    expect(release).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(resize, {
      pointerId: 7,
      pointerType,
      clientX: 1000,
      clientY: 1000,
    });
    expect(parseFloat(piece.style.width)).toBeCloseTo(60);
    expect(canvas.querySelector("button button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    const persisted = mocks.send.mock.calls[0][1].layout.placements[0];
    expect(persisted.width).toBeCloseTo(60);
    expect(persisted).toMatchObject({ x: 50, y: 50, rotation: 30 });
  },
);

it("clamps resize bounds, ignores unrelated pointers and stops after pointer cancellation", () => {
  const { piece, resize } = mountHandleCanvas();
  fireEvent.pointerDown(resize, {
    pointerId: 2,
    button: 0,
    clientX: 300,
    clientY: 360,
  });
  fireEvent.pointerMove(resize, {
    pointerId: 3,
    clientX: 10000,
    clientY: 10000,
  });
  expect(piece).toHaveStyle({ width: "40%" });
  fireEvent.pointerMove(resize, {
    pointerId: 2,
    clientX: 10000,
    clientY: 10000,
  });
  expect(piece).toHaveStyle({ width: "85%" });
  fireEvent.pointerMove(resize, { pointerId: 2, clientX: 220, clientY: 280 });
  expect(piece).toHaveStyle({ width: "8%" });
  fireEvent.pointerCancel(resize, { pointerId: 2 });
  fireEvent.pointerMove(resize, {
    pointerId: 2,
    clientX: 10000,
    clientY: 10000,
  });
  expect(piece).toHaveStyle({ width: "8%" });
});

it("rotates around the canvas-relative center across 180 degrees without moving or resizing the item", async () => {
  const { piece, rotate } = mountHandleCanvas(170);
  fireEvent.pointerDown(rotate, {
    pointerId: 4,
    button: 0,
    clientX: 320,
    clientY: 280,
  });
  fireEvent.pointerMove(rotate, {
    pointerId: 4,
    clientX: 220 + 100 * Math.cos(Math.PI / 6),
    clientY: 330,
  });
  expect(piece).toHaveStyle({ left: "50%", top: "50%", width: "40%" });
  expect(screen.getByRole("slider", { name: "单品旋转" })).toHaveValue("-160");
  fireEvent.lostPointerCapture(rotate, { pointerId: 4 });
  fireEvent.pointerMove(rotate, { pointerId: 4, clientX: 220, clientY: 380 });
  expect(screen.getByRole("slider", { name: "单品旋转" })).toHaveValue("-160");
  fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  expect(mocks.send.mock.calls[0][1].layout.placements[0]).toMatchObject({
    x: 50,
    y: 50,
    width: 40,
    rotation: -160,
  });
});

it("keeps keyboard and slider alternatives available for both direct handles", () => {
  const { piece, resize, rotate } = mountHandleCanvas();
  fireEvent.keyDown(resize, { key: "ArrowRight" });
  expect(piece).toHaveStyle({ width: "41%" });
  fireEvent.keyDown(resize, { key: "ArrowLeft", shiftKey: true });
  expect(piece).toHaveStyle({ width: "36%" });
  fireEvent.keyDown(rotate, { key: "ArrowRight" });
  fireEvent.keyDown(rotate, { key: "ArrowUp", shiftKey: true });
  expect(screen.getByRole("slider", { name: "单品旋转" })).toHaveValue("20");
  fireEvent.change(screen.getByRole("slider", { name: "单品大小" }), {
    target: { value: "50" },
  });
  expect(piece).toHaveStyle({ width: "50%" });
  expect(rotate).toHaveAccessibleDescription(/方向键微调/);
});

it.each([0, 45])(
  "keeps both 44px handles separate and inside the canvas at its top-right edge with %s degree rotation",
  (rotation) => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { canvas, resize, rotate } = mountHandleCanvas(rotation, {
      x: 100,
      y: 0,
    });
    fireEvent.change(screen.getByRole("slider", { name: "单品大小" }), {
      target: { value: "8" },
    });
    function checkBounds(width: number, height: number) {
      const points = [resize, rotate].map((handle) => ({
        x: parseFloat(handle.style.left),
        y: parseFloat(handle.style.top),
      }));
      for (const point of points) {
        expect(point.x).toBeGreaterThanOrEqual(22);
        expect(point.x).toBeLessThanOrEqual(width - 22);
        expect(point.y).toBeGreaterThanOrEqual(22);
        expect(point.y).toBeLessThanOrEqual(height - 22);
      }
      expect(
        Math.abs(points[0].x - points[1].x) >= 44 ||
          Math.abs(points[0].y - points[1].y) >= 44,
      ).toBe(true);
    }
    checkBounds(400, 500);
    vi.mocked(canvas.getBoundingClientRect).mockReturnValue({
      width: 320,
      height: 400,
      left: 20,
      top: 30,
      x: 20,
      y: 30,
      right: 340,
      bottom: 430,
      toJSON: () => ({}),
    });
    fireEvent.resize(window);
    checkBounds(320, 400);
  },
);

it.each(["balanced", "grid", "editorial"] as const)(
  "reflows %s template membership after removal and addition instead of stacking garments at identical coordinates",
  async (template) => {
    const initialIds = ["top", "bottom"];
    const layout: OutfitLayout = {
      version: 1,
      mode: "collage",
      template,
      background: "#ffffff",
      placements: templatePlacements(initialIds, fixture().items, template),
    };
    mount(
      <OutfitEditor
        outfit={{ ...saved(layout), item_ids: initialIds }}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "从搭配移除白色衬衫" }));
    fireEvent.click(screen.getByRole("button", { name: "白色运动鞋" }));
    const first = screen.getByRole("button", { name: "调整蓝色长裤" });
    const second = screen.getByRole("button", { name: "调整白色运动鞋" });
    expect([first.style.left, first.style.top]).not.toEqual([
      second.style.left,
      second.style.top,
    ]);
    fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0][1].layout.placements).toEqual(
      templatePlacements(["bottom", "shoes"], fixture().items, template),
    );
  },
);

it.each(["none", "openai"] as const)(
  "blocks preserving more than 12 items for %s recommendations and never silently truncates them",
  async (provider) => {
    const state = fixture();
    state.ai.provider = provider;
    state.ai.capabilities.text = provider === "openai";
    state.items = Array.from({ length: 13 }, (_, index) => ({
      ...shirt,
      id: String(index),
      name: `保留单品${index}`,
    }));
    mount(
      <OutfitEditor
        outfit={{ ...saved(), item_ids: state.items.map((item) => item.id) }}
        onClose={vi.fn()}
      />,
      state,
    );
    fireEvent.click(mode("AI 推荐"));
    const preserve = screen.getByRole("checkbox", {
      name: /保留已选单品再推荐/,
    });
    fireEvent.click(preserve);
    const generate = screen.getByRole("button", {
      name: provider === "openai" ? "生成 AI 推荐" : "生成规则推荐",
    });
    expect(generate).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "已选 13 件，推荐最多保留 12 件",
    );
    fireEvent.click(generate);
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "从搭配移除保留单品12" }),
    );
    expect(generate).toBeEnabled();
    mocks.send.mockResolvedValueOnce({
      outfits: [],
      missing: [],
      message: "暂无组合",
    });
    fireEvent.click(generate);
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0][1].locked_ids).toEqual(
      state.items.slice(0, 12).map((item) => item.id),
    );
  },
);
