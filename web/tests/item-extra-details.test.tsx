import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ItemExtraDetails } from "../src/components/ItemExtraDetails";
import {
  itemAttributeDraft,
  type ItemAttributeDraft,
} from "../src/item-attributes";
import { shirt } from "./fixtures";

const close = vi.fn();
const changed = vi.fn();
const submitted = vi.fn();
const fetcher = vi.fn();

function Details({
  initial = itemAttributeDraft(shirt),
}: {
  initial?: ItemAttributeDraft;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted();
      }}
    >
      <ItemExtraDetails
        item={shirt}
        value={value}
        onChange={(field, next) => {
          changed(field, next);
          setValue((current) => ({ ...current, [field]: next }));
        }}
        onClose={close}
      />
      <output data-testid="draft">{JSON.stringify(value)}</output>
    </form>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

it("opens only supplemental fields with empty values for an older item", () => {
  render(<Details />);
  const dialog = screen.getByRole("dialog", { name: "详情" });
  expect(within(dialog).getByText("白色衬衫")).toBeInTheDocument();
  expect(within(dialog).getByText("上衣")).toBeInTheDocument();
  for (const label of [
    "风格",
    "合身度",
    "版型",
    "领型",
    "袖长",
    "长度",
    "洗护说明",
  ]) {
    expect(within(dialog).getByLabelText(label)).toHaveValue("");
  }
  expect(within(dialog).queryByLabelText("材质")).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText("尺码")).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText("图案")).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("tablist")).not.toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it("updates the shared draft through field callbacks and preserves main-form values", () => {
  const initial = {
    ...itemAttributeDraft(shirt),
    materials: ["棉"],
    size: "M",
    pattern: "纯色",
  };
  render(<Details initial={initial} />);
  fireEvent.click(
    within(screen.getByRole("group", { name: "风格建议" })).getByRole(
      "button",
      { name: "极简" },
    ),
  );
  fireEvent.click(
    within(screen.getByRole("group", { name: "风格建议" })).getByRole(
      "button",
      { name: "通勤" },
    ),
  );
  fireEvent.click(
    within(screen.getByRole("group", { name: "合身度建议" })).getByRole(
      "button",
      { name: "宽松" },
    ),
  );
  fireEvent.change(screen.getByLabelText("领型"), {
    target: { value: "小尖领" },
  });
  fireEvent.change(screen.getByLabelText("洗护说明"), {
    target: { value: "按衣标轻柔手洗\n平铺晾干" },
  });
  expect(changed).toHaveBeenCalledWith("styles", ["极简", "通勤"]);
  expect(changed).toHaveBeenCalledWith("fit", "宽松");
  expect(changed).toHaveBeenCalledWith("neckline", "小尖领");
  expect(changed).toHaveBeenCalledWith(
    "care_notes",
    "按衣标轻柔手洗\n平铺晾干",
  );
  const draft = JSON.parse(screen.getByTestId("draft").textContent!);
  expect(draft).toMatchObject({
    ...initial,
    styles: ["极简", "通勤"],
    fit: "宽松",
    neckline: "小尖领",
    care_notes: "按衣标轻柔手洗\n平铺晾干",
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(submitted).not.toHaveBeenCalled();
});

it("completes by closing the sheet without submitting its parent form or calling an API", () => {
  render(<Details />);
  fireEvent.change(screen.getByLabelText("洗护说明"), {
    target: { value: "不可烘干" },
  });
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  expect(close).toHaveBeenCalledOnce();
  expect(submitted).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(JSON.parse(screen.getByTestId("draft").textContent!).care_notes).toBe(
    "不可烘干",
  );
});

it("shows the actual small photo and follows draft changes supplied by the editor", () => {
  const item = { ...shirt, image_url: "/api/images/actual-original.jpg" };
  const value = itemAttributeDraft(item);
  const view = render(
    <ItemExtraDetails
      item={item}
      value={value}
      onChange={changed}
      onClose={close}
    />,
  );
  expect(screen.getByRole("img", { name: "白色衬衫" })).toHaveAttribute(
    "src",
    item.image_url,
  );
  view.rerender(
    <ItemExtraDetails
      item={item}
      value={{
        ...value,
        styles: ["经典"],
        cut: "直筒",
        sleeve_length: "长袖",
        length: "常规",
        care_notes: "低温熨烫",
      }}
      onChange={changed}
      onClose={close}
    />,
  );
  expect(screen.getByLabelText("风格")).toHaveValue("经典");
  expect(screen.getByLabelText("版型")).toHaveValue("直筒");
  expect(screen.getByLabelText("袖长")).toHaveValue("长袖");
  expect(screen.getByLabelText("长度")).toHaveValue("常规");
  expect(screen.getByLabelText("洗护说明")).toHaveValue("低温熨烫");
  expect(changed).not.toHaveBeenCalled();
});

it("closing with Escape retains edits in the shared draft", () => {
  render(<Details />);
  fireEvent.change(screen.getByLabelText("长度"), {
    target: { value: "及踝" },
  });
  fireEvent(
    screen.getByRole("dialog", { name: "详情" }),
    new Event("cancel", { bubbles: true, cancelable: true }),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(JSON.parse(screen.getByTestId("draft").textContent!).length).toBe(
    "及踝",
  );
  expect(fetcher).not.toHaveBeenCalled();
});
