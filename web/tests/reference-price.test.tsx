import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AppProvider } from "../src/Store";
import { ItemEditor } from "../src/components/Items";
import { costPerWear, type Item, type ReferencePrice } from "../src/types";
import { fixture, shirt } from "./fixtures";
const mocks = vi.hoisted(() => ({ send: vi.fn(), refresh: vi.fn() }));
vi.mock("../src/api", () => ({
  api: vi.fn(),
  send: mocks.send,
  failure: (error: Error) => error.message,
}));
const reference: ReferencePrice = {
  amount: 198.5,
  currency: "USD",
  label: "页面售价",
  source_url: "https://shop.example.com/product/1",
  observed_at: "2026-09-09T12:00:00Z",
};
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
const imported = (): Item => ({
  ...shirt,
  confirmed: false,
  price: null,
  currency: "CNY",
  reference_price: reference,
  wear_count: 2,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(undefined);
});

it("shows the imported reference price, domain and observation date without filling purchase data", () => {
  const item = imported();
  render(editor(item));
  const panel = screen.getByRole("complementary", { name: "参考价格" });
  expect(panel).toHaveTextContent("参考价 · 页面售价");
  expect(panel).toHaveTextContent("US$198.50");
  expect(panel).toHaveTextContent("shop.example.com");
  expect(panel.querySelector("time")).toHaveAttribute(
    "datetime",
    reference.observed_at,
  );
  expect(screen.getByLabelText("购买价格")).toHaveValue(null);
  expect(screen.getByLabelText("币种")).toHaveValue("CNY");
  expect(costPerWear(item)).toBe("尚未记录价格");
  expect(mocks.send).not.toHaveBeenCalled();
});

it("fills reference amount and currency only on click and persists only on save", async () => {
  render(editor(imported()));
  fireEvent.click(screen.getByRole("button", { name: "用作购入价" }));
  expect(screen.getByLabelText("购买价格")).toHaveValue(198.5);
  expect(screen.getByLabelText("币种")).toHaveValue("USD");
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/items/top",
      expect.objectContaining({ price: "198.50", currency: "USD" }),
      "PATCH",
    ),
  );
  expect(mocks.send.mock.calls[0][1]).not.toHaveProperty("reference_price");
});

it("keeps actual purchase price empty when the user confirms without using the reference", async () => {
  render(editor(imported()));
  fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/items/top",
      expect.objectContaining({ price: null, currency: "CNY" }),
      "PATCH",
    ),
  );
});

it("preserves an existing purchase price and manual edits until the explicit replace action", () => {
  const item = { ...imported(), price: "120.00", currency: "EUR" };
  const view = render(editor(item));
  expect(screen.getByLabelText("购买价格")).toHaveValue(120);
  expect(screen.getByLabelText("币种")).toHaveValue("EUR");
  expect(
    screen.getByRole("button", { name: "替换为参考价" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("购买价格"), {
    target: { value: "80" },
  });
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "我的衬衫" },
  });
  view.rerender(
    editor({
      ...item,
      reference_price: { ...reference, amount: 199 },
      updated_at: "2026-09-09T12:01:00Z",
      ai_status: "review",
    }),
  );
  expect(screen.getByLabelText("购买价格")).toHaveValue(80);
  expect(screen.getByLabelText("名称")).toHaveValue("我的衬衫");
  fireEvent.click(screen.getByRole("button", { name: "替换为参考价" }));
  expect(screen.getByLabelText("购买价格")).toHaveValue(199);
  expect(screen.getByLabelText("币种")).toHaveValue("USD");
  expect(screen.getByLabelText("名称")).toHaveValue("我的衬衫");
  expect(mocks.send).not.toHaveBeenCalled();
});

it("shows release price as a reference rather than actual paid amount", () => {
  render(
    editor({
      ...imported(),
      reference_price: { ...reference, label: "发售价格" },
    }),
  );
  expect(
    screen.getByRole("complementary", { name: "参考价格" }),
  ).toHaveTextContent("参考价 · 发售价格");
  expect(
    screen.getByText("仅供参考，不代表实际支付金额。"),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("购买价格")).toHaveValue(null);
});

it("does not show a reference panel for garments without one", () => {
  render(editor({ ...shirt, reference_price: null }));
  expect(
    screen.queryByRole("complementary", { name: "参考价格" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "用作购入价" }),
  ).not.toBeInTheDocument();
});
