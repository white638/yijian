import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AppProvider } from "../src/Store";
import { Collage } from "../src/components/UI";
import {
  ItemPicker,
  OutfitEditor,
  PlanEditor,
} from "../src/components/Outfits";
import { AddSheet, ItemEditor } from "../src/components/Items";
import type { Item, Outfit } from "../src/types";
import { fixture, shirt } from "./fixtures";

const mocks = vi.hoisted(() => ({ send: vi.fn(), refresh: vi.fn() }));
vi.mock("../src/api", () => ({
  api: vi.fn(),
  send: mocks.send,
  failure: (error: Error) => error.message,
}));

const accessories: Item[] = [
  { ...shirt, id: "bag", name: "棕色托特包", category: "bag", tags: [] },
  {
    ...shirt,
    id: "hat",
    name: "米色小物",
    category: "accessory",
    tags: ["帽子"],
  },
  {
    ...shirt,
    id: "scarf",
    name: "蓝色小物",
    category: "accessory",
    tags: ["围巾"],
  },
  {
    ...shirt,
    id: "belt",
    name: "黑色小物",
    category: "accessory",
    tags: ["腰带"],
  },
  {
    ...shirt,
    id: "watch",
    name: "银色小物",
    category: "accessory",
    tags: ["手表"],
  },
];
const items = [...fixture().items, ...accessories];
const outfit: Outfit = {
  id: "accessory-look",
  name: "秋日出门",
  item_ids: items.map((i) => i.id),
  notes: "",
  source: "manual",
  created_at: "2026-09-09T00:00:00Z",
};
function mount(children: ReactNode) {
  const state = fixture();
  state.items = items;
  state.outfits = [outfit];
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(undefined);
});

it("indicates accessories beyond the sixth thumbnail and renders every image and name in the full view", () => {
  const photos = items.map((item) => ({
    ...item,
    image_url: `/api/images/${item.id}.jpg`,
  }));
  const view = render(<Collage ids={outfit.item_ids} items={photos} />);
  const preview = screen.getByRole("group", { name: "搭配预览（8 件）" });
  expect(within(preview).getAllByRole("img")).toHaveLength(6);
  expect(within(preview).getByLabelText("另有 2 件单品")).toHaveTextContent(
    "+2",
  );
  view.rerender(<Collage ids={outfit.item_ids} items={photos} expanded />);
  const full = screen.getByRole("group", { name: "搭配全部单品（8 件）" });
  expect(within(full).getAllByRole("img")).toHaveLength(8);
  for (const item of items) {
    expect(
      within(full).getByRole("img", { name: item.name }),
    ).toBeInTheDocument();
    expect(within(full).getByText(item.name)).toBeInTheDocument();
  }
  expect(within(full).queryByText("+2")).not.toBeInTheDocument();
});

it("shows all eight selected garments in the editor and saves the bag and every accessory ID", async () => {
  mount(<OutfitEditor outfit={outfit} onClose={vi.fn()} />);
  const full = screen.getByRole("group", { name: "搭配全部单品（8 件）" });
  for (const item of items)
    expect(within(full).getByText(item.name)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/outfits/accessory-look",
      expect.objectContaining({ item_ids: outfit.item_ids }),
      "PATCH",
    ),
  );
});

it("shows every accessory when planning a saved outfit", () => {
  mount(
    <PlanEditor
      itemIds={outfit.item_ids}
      outfitId={outfit.id}
      onClose={vi.fn()}
    />,
  );
  const full = screen.getByRole("group", { name: "搭配全部单品（8 件）" });
  for (const item of accessories)
    expect(within(full).getByText(item.name)).toBeVisible();
});

it("finds an accessory by its subtype tag and selects the real item without losing existing choices", () => {
  const change = vi.fn();
  mount(<ItemPicker selected={["top", "bag"]} onChange={change} />);
  fireEvent.change(screen.getByRole("textbox", { name: "搜索可选衣物" }), {
    target: { value: "腰带" },
  });
  expect(
    screen.queryByRole("button", { name: "白色衬衫" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "棕色托特包" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "黑色小物" }));
  expect(change).toHaveBeenCalledWith(["top", "bag", "belt"]);
});

it.each(["manual", "edit"])(
  "explains accessory subtypes and keeps bags separate in %s category selection",
  (mode) => {
    if (mode === "manual") {
      mount(<AddSheet onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /手动记录衣物/ }));
    } else {
      mount(<ItemEditor item={accessories[1]} onClose={vi.fn()} />);
    }
    const category = screen.getByRole("combobox", { name: "类别" });
    fireEvent.change(category, { target: { value: "accessory" } });
    expect(category).toHaveAccessibleDescription(
      "帽子、围巾、腰带、首饰、手表等归入配饰；包袋请单独选择“包袋”。",
    );
    fireEvent.change(category, { target: { value: "bag" } });
    expect(category).toHaveValue("bag");
    expect(category).not.toHaveAttribute("aria-describedby");
  },
);
