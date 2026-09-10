import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AppProvider } from "../src/Store";
import { ItemEditor } from "../src/components/Items";
import type { Item } from "../src/types";
import { fixture, shirt } from "./fixtures";
const mocks = vi.hoisted(() => ({ send: vi.fn(), refresh: vi.fn() }));
vi.mock("../src/api", () => ({
  api: vi.fn(),
  send: mocks.send,
  failure: (error: Error) => error.message,
}));
function editor(item: Item) {
  return (
    <AppProvider
      value={{
        state: fixture(),
        refresh: mocks.refresh,
        notify: vi.fn(),
        openItem: vi.fn(),
        openAdd: vi.fn(),
        openOutfit: vi.fn(),
        openPlan: vi.fn(),
        navigate: vi.fn(),
      }}
    >
      <ItemEditor item={item} onClose={vi.fn()} />
    </AppProvider>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.send.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(undefined);
});

it("keeps primary fields visible and puts extra details immediately before final save", () => {
  render(editor(shirt));
  for (const label of ["子分类", "材质", "图案", "尺码"])
    expect(screen.getByLabelText(label)).toHaveValue("");
  expect(screen.queryByLabelText("合身度")).not.toBeInTheDocument();
  const detail = screen.getByRole("button", { name: /详情.*风格/ });
  expect(detail.nextElementSibling).toBe(
    screen.getByRole("button", { name: "确认并保存" }),
  );
  fireEvent.click(detail);
  expect(screen.getByLabelText("合身度")).toHaveValue("");
  expect(screen.getByLabelText("洗护说明")).toHaveValue("");
  expect(mocks.send).not.toHaveBeenCalled();
});

it("combines custom main fields and detail choices into one explicit save", async () => {
  render(editor(shirt));
  fireEvent.click(
    within(screen.getByRole("group", { name: "子分类建议" })).getByRole(
      "button",
      { name: "衬衫" },
    ),
  );
  fireEvent.change(screen.getByLabelText("材质"), {
    target: { value: "棉、亚麻、棉" },
  });
  fireEvent.change(screen.getByLabelText("图案"), {
    target: { value: "细格纹" },
  });
  fireEvent.change(screen.getByLabelText("尺码"), {
    target: { value: "M / 170" },
  });
  fireEvent.click(screen.getByRole("button", { name: /详情.*风格/ }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "风格建议" })).getByRole(
      "button",
      { name: "极简" },
    ),
  );
  fireEvent.change(screen.getByLabelText("合身度"), {
    target: { value: "合身" },
  });
  fireEvent.change(screen.getByLabelText("洗护说明"), {
    target: { value: "30°C 手洗" },
  });
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  expect(mocks.send).not.toHaveBeenCalled();
  expect(screen.getByLabelText("尺码")).toHaveValue("M / 170");
  fireEvent.click(screen.getByRole("button", { name: /详情.*风格/ }));
  expect(screen.getByLabelText("风格")).toHaveValue("极简");
  expect(screen.getByLabelText("洗护说明")).toHaveValue("30°C 手洗");
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/items/top",
      expect.objectContaining({
        subcategory: "衬衫",
        materials: ["棉", "亚麻"],
        pattern: "细格纹",
        size: "M / 170",
        styles: ["极简"],
        fit: "合身",
        care_notes: "30°C 手洗",
      }),
      "PATCH",
    ),
  );
});

it("auto-fills observable attributes while preserving changed values, size and care drafts", () => {
  const mounted = render(
    editor({
      ...shirt,
      ai_status: "processing",
      size: "M",
      care_notes: "手洗",
    }),
  );
  fireEvent.change(screen.getByLabelText("子分类"), {
    target: { value: "我的定制衬衫" },
  });
  fireEvent.change(screen.getByLabelText("材质"), { target: { value: "棉" } });
  fireEvent.click(screen.getByRole("button", { name: /详情.*风格/ }));
  fireEvent.change(screen.getByLabelText("合身度"), {
    target: { value: "合身" },
  });
  mounted.rerender(
    editor({
      ...shirt,
      ai_status: "review",
      updated_at: "2026-09-10T12:00:00Z",
      subcategory: "衬衫",
      materials: ["亚麻"],
      pattern: "格纹",
      styles: ["通勤"],
      fit: "宽松",
      size: "不可采用的识别尺码",
      care_notes: "不可采用的识别洗护",
      neckline: "翻领",
    }),
  );
  expect(screen.getByLabelText("合身度")).toHaveValue("合身");
  expect(screen.getByLabelText("风格")).toHaveValue("通勤");
  expect(screen.getByLabelText("洗护说明")).toHaveValue("手洗");
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  expect(screen.getByLabelText("子分类")).toHaveValue("我的定制衬衫");
  expect(screen.getByLabelText("材质")).toHaveValue("棉");
  expect(screen.getByLabelText("图案")).toHaveValue("格纹");
  expect(screen.getByLabelText("尺码")).toHaveValue("M");
});

it("offers accessory subcategories without mixing them into bags", () => {
  render(editor({ ...shirt, category: "accessory" }));
  const choices = screen.getByRole("group", { name: "子分类建议" });
  expect(
    within(choices).getByRole("button", { name: "项链" }),
  ).toBeInTheDocument();
  fireEvent.click(within(choices).getByRole("button", { name: "手表" }));
  expect(screen.getByLabelText("子分类")).toHaveValue("手表");
  fireEvent.change(screen.getByLabelText("类别"), { target: { value: "bag" } });
  expect(
    within(choices).getByRole("button", { name: "斜挎包" }),
  ).toBeInTheDocument();
  expect(
    within(choices).queryByRole("button", { name: "项链" }),
  ).not.toBeInTheDocument();
});

it("keeps every field in a pending final save disabled and restores editing after failure", async () => {
  let reject!: (error: Error) => void;
  mocks.send.mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  render(editor(shirt));
  fireEvent.change(screen.getByLabelText("子分类"), {
    target: { value: "衬衫" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
  expect(screen.getByLabelText("子分类")).toBeDisabled();
  expect(screen.getByRole("button", { name: /详情.*风格/ })).toBeDisabled();
  reject(new Error("暂时无法保存。"));
  await screen.findByText("暂时无法保存。");
  expect(screen.getByLabelText("子分类")).toBeEnabled();
  expect(screen.getByLabelText("子分类")).toHaveValue("衬衫");
});
