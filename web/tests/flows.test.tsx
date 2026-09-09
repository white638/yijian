import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AppProvider } from "../src/Store";
import { AIConnect } from "../src/components/AIConnect";
import { OutfitEditor, PlanEditor } from "../src/components/Outfits";
import { ItemEditor } from "../src/components/Items";
import { Stats } from "../src/pages/Settings";
import { costPerWear, mergeTripItems } from "../src/types";
import { fixture, shirt } from "./fixtures";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
  plan: vi.fn(),
}));
vi.mock("../src/api", () => ({
  api: mocks.api,
  send: mocks.send,
  failure: (e: Error) => e.message,
  downloadBackup: vi.fn(),
}));
function mount(children: ReactNode, state = fixture()) {
  return render(
    <AppProvider
      value={{
        state,
        refresh: mocks.refresh,
        notify: mocks.notify,
        openPlan: mocks.plan,
        openItem: vi.fn(),
        openAdd: vi.fn(),
        openOutfit: vi.fn(),
        navigate: vi.fn(),
      }}
    >
      {children}
    </AppProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(undefined);
  mocks.api.mockResolvedValue({});
});
describe("persistent wardrobe flows", () => {
  it("starts with optional AI and skips without sending a provider configuration", () => {
    const done = vi.fn();
    mount(<AIConnect onFinish={done} />);
    expect(screen.getByText("先连接你的 AI 助手")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "跳过，先逛逛衣柜" }));
    expect(done).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("stores host mode without keys or models and only generates a code after explicit action", async () => {
    const done = vi.fn();
    mount(<AIConnect onFinish={done} />);
    fireEvent.click(screen.getByRole("button", { name: "保存并开始" }));
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(mocks.send).toHaveBeenCalledWith(
      "/ai/settings",
      { provider: "codex", base_url: "", text_model: "", vision_model: "" },
      "PUT",
    );
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("clears the write-only API key after saving", async () => {
    mount(<AIConnect />);
    fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
    const key = screen.getByLabelText("接口密钥");
    expect(key).toHaveAttribute("type", "password");
    fireEvent.change(key, { target: { value: "test-private-key" } });
    fireEvent.change(screen.getByLabelText("文本模型"), {
      target: { value: "test-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(key).toHaveValue(""));
    expect(mocks.send).toHaveBeenCalledWith(
      "/ai/settings",
      expect.objectContaining({
        api_key: "test-private-key",
        text_model: "test-model",
      }),
      "PUT",
    );
    expect(localStorage.length).toBe(0);
  });
  it("saves a manual outfit containing selected real item IDs without recording wear", async () => {
    mount(<OutfitEditor onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "白色衬衫" }));
    fireEvent.click(screen.getByRole("button", { name: "蓝色长裤" }));
    fireEvent.click(screen.getByRole("button", { name: "白色运动鞋" }));
    fireEvent.change(screen.getByLabelText("搭配名称"), {
      target: { value: "周末出门" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        "/outfits",
        {
          name: "周末出门",
          item_ids: ["top", "bottom", "shoes"],
          notes: "",
          source: "manual",
        },
        "POST",
      ),
    );
    expect(mocks.send.mock.calls.some((c) => c[0] === "/wear")).toBe(false);
  });
  it("planning does not imply actual wear", async () => {
    mount(
      <PlanEditor
        itemIds={["top", "bottom", "shoes"]}
        name="明日通勤"
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("日期"), {
      target: { value: "2026-10-20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存到日历" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        "/plans",
        expect.objectContaining({
          date: "2026-10-20",
          item_ids: ["top", "bottom", "shoes"],
        }),
        "POST",
      ),
    );
    expect(mocks.send.mock.calls.some((c) => c[0] === "/wear")).toBe(false);
  });
  it.each(["input", "change"] as const)(
    "submits the newly selected date when an existing plan is edited via %s and blurred",
    async (event) => {
      mount(
        <PlanEditor
          itemIds={["top"]}
          plan={{
            id: "existing-plan",
            date: "2026-09-09",
            name: "旅行穿搭",
            item_ids: ["top"],
            notes: "",
            outfit_id: null,
          }}
          onClose={vi.fn()}
        />,
      );
      const date = screen.getByLabelText("日期");
      expect(date).toHaveValue("2026-09-09");
      fireEvent[event](date, { target: { value: "2026-09-10" } });
      fireEvent.blur(date);
      expect(date).toHaveValue("2026-09-10");
      fireEvent.click(screen.getByRole("button", { name: "保存到日历" }));
      await waitFor(() =>
        expect(mocks.send).toHaveBeenCalledWith(
          "/plans/existing-plan",
          expect.objectContaining({ date: "2026-09-10" }),
          "PATCH",
        ),
      );
    },
  );
  it("preserves an unknown currency when migrated purchase details are saved", async () => {
    mount(<ItemEditor item={shirt} onClose={vi.fn()} />);
    expect(screen.getByLabelText("币种")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        "/items/top",
        expect.objectContaining({
          currency: null,
          price: "120.00",
          confirmed: true,
        }),
        "PATCH",
      ),
    );
  });
  it("Chinese insights use the true un-worn count", () => {
    const state = fixture();
    state.insights.unworn = 7;
    mount(<Stats />, state);
    expect(
      screen.getByText("你有 7 件衣物还没有穿着记录，可以试着用它们搭配。"),
    ).toBeInTheDocument();
  });
});
describe("cost and packing data rules", () => {
  it("treats a zero price as real while distinguishing missing price and unworn items", () => {
    expect(
      costPerWear({ ...shirt, price: "0", currency: "CNY", wear_count: 2 }),
    ).toContain("0.00");
    expect(costPerWear({ ...shirt, price: null })).toBe("尚未记录价格");
    expect(costPerWear(shirt)).toBe("尚未穿着");
    expect(costPerWear({ ...shirt, wear_count: 2 })).toBe("60（币种未填）");
  });
  it("deduplicates whole-outfit additions and preserves already-packed status", () => {
    expect(
      mergeTripItems(
        [{ item_id: "top", packed: true }],
        ["top", "bottom", "bottom"],
      ),
    ).toEqual([
      { item_id: "top", packed: true },
      { item_id: "bottom", packed: false },
    ]);
  });
});
