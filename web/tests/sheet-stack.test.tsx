import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Sheet } from "../src/components/UI";

function NestedSheets({ busy = false }: { busy?: boolean }) {
  const [parent, setParent] = useState(true);
  const [child, setChild] = useState(false);
  const [draft, setDraft] = useState("");
  return parent ? (
    <Sheet title="主编辑" onClose={() => setParent(false)}>
      <input
        aria-label="主表单草稿"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button onClick={() => setChild(true)}>打开补充资料</button>
      {child && (
        <Sheet title="补充资料" busy={busy} onClose={() => setChild(false)}>
          <input aria-label="补充内容" />
          <button>完成</button>
        </Sheet>
      )}
    </Sheet>
  ) : (
    <p>编辑已关闭</p>
  );
}

it("Escape closes only the top nested sheet and keeps the parent's unsaved draft and focus", () => {
  render(<NestedSheets />);
  fireEvent.change(screen.getByLabelText("主表单草稿"), {
    target: { value: "待保存的衬衫名称" },
  });
  const trigger = screen.getByRole("button", { name: "打开补充资料" });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(
    screen.queryByRole("dialog", { name: "补充资料" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "主编辑" })).toBeInTheDocument();
  expect(screen.getByLabelText("主表单草稿")).toHaveValue("待保存的衬衫名称");
  expect(trigger).toHaveFocus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByText("编辑已关闭")).toBeInTheDocument();
});

it("a busy top sheet consumes Escape without closing itself or the parent", () => {
  render(<NestedSheets busy />);
  fireEvent.click(screen.getByRole("button", { name: "打开补充资料" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getAllByRole("dialog")).toHaveLength(2);
  expect(
    within(screen.getByRole("dialog", { name: "补充资料" })).getByRole(
      "button",
      { name: "关闭" },
    ),
  ).toBeDisabled();
});

it("Tab and Shift+Tab cycle within the top sheet instead of reaching the parent", () => {
  render(<NestedSheets />);
  fireEvent.click(screen.getByRole("button", { name: "打开补充资料" }));
  const child = screen.getByRole("dialog", { name: "补充资料" });
  const first = within(child).getByRole("button", { name: "关闭" });
  const last = within(child).getByRole("button", { name: "完成" });
  for (const element of child.querySelectorAll<HTMLElement>("button,input")) {
    vi.spyOn(element, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 44, 44),
    ] as unknown as DOMRectList);
  }
  last.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(first).toHaveFocus();
  first.focus();
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(last).toHaveFocus();
});

it("restores page scrolling when a parent and nested sheet unmount together", () => {
  document.body.style.overflow = "auto";
  const mounted = render(<NestedSheets />);
  fireEvent.click(screen.getByRole("button", { name: "打开补充资料" }));
  expect(document.body.style.overflow).toBe("hidden");
  mounted.unmount();
  expect(document.body.style.overflow).toBe("auto");
  document.body.style.overflow = "";
});
