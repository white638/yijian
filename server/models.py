from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Literal
from urllib.parse import urlsplit

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

Category = Literal["top", "bottom", "dress", "outerwear", "shoes", "bag", "accessory", "other"]
Status = Literal["available", "laundry", "archived"]
Currency = Literal["CNY", "USD", "EUR", "GBP", "JPY", "KRW", "HKD", "TWD", "CAD", "AUD", "CHF"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SessionInput(StrictModel):
    code: SecretStr | None = Field(default=None, max_length=200)


class ReferencePrice(StrictModel):
    amount: float = Field(ge=0, le=100000000, allow_inf_nan=False, strict=True)
    currency: Currency
    label: Literal["页面售价", "起售价", "发售价格"]
    observed_at: AwareDatetime
    source_url: str = Field(min_length=1, max_length=2600)

    @field_validator("amount")
    @classmethod
    def money_precision(cls, value):
        return float(Decimal(str(value)).quantize(Decimal("0.01")))

    @field_validator("source_url")
    @classmethod
    def product_source(cls, value):
        try:
            parsed = urlsplit(value)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.port not in {None, 80, 443}
            ):
                raise ValueError
        except ValueError:
            raise ValueError("参考价格来源必须是有效的商品网址。") from None
        return value


class ItemInput(StrictModel):
    name: str = Field(default="未命名单品", min_length=1, max_length=120)
    category: Category = "other"
    colors: list[str] = Field(default_factory=list, max_length=10)
    seasons: list[str] = Field(default_factory=list, max_length=4)
    occasions: list[str] = Field(default_factory=list, max_length=8)
    tags: list[str] = Field(default_factory=list, max_length=30)
    status: Status = "available"
    confirmed: bool = False
    favorite: bool = False
    price: str | None = None
    currency: Currency | None = "CNY"
    brand: str = Field(default="", max_length=120)
    closet: str = Field(default="日常衣橱", min_length=1, max_length=80)
    notes: str = Field(default="", max_length=3000)
    purchased_at: date | None = None

    @field_validator("price", mode="before")
    @classmethod
    def valid_price(cls, value):
        if value is None or value == "":
            return None
        try:
            number = Decimal(str(value))
            if not number.is_finite() or number < 0 or number > 100000000:
                raise ValueError("请输入有效的购买价格。")
            return str(number.quantize(Decimal("0.01")))
        except (InvalidOperation, TypeError):
            raise ValueError("请输入有效的购买价格。") from None

    @field_validator("colors", "seasons", "occasions", "tags")
    @classmethod
    def compact_labels(cls, values):
        if any(len(v) > 80 for v in values):
            raise ValueError("标签过长。")
        return list(dict.fromkeys(v.strip() for v in values if v.strip()))


class ItemPatch(ItemInput):
    pass


class OutfitPlacement(StrictModel):
    item_id: str = Field(min_length=1, max_length=80)
    x: float = Field(ge=0, le=100, allow_inf_nan=False, strict=True)
    y: float = Field(ge=0, le=100, allow_inf_nan=False, strict=True)
    width: float = Field(ge=8, le=85, allow_inf_nan=False, strict=True)
    rotation: float = Field(ge=-180, le=180, allow_inf_nan=False, strict=True)


class OutfitLayout(StrictModel):
    version: Literal[1] = 1
    mode: Literal["free", "categories", "collage", "ai"]
    template: Literal["balanced", "grid", "editorial"]
    background: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    placements: list[OutfitPlacement] = Field(max_length=24)

    def check_items(self, item_ids: list[str]):
        placed = [entry.item_id for entry in self.placements]
        if len(placed) != len(set(placed)) or set(placed) != set(item_ids):
            raise ValueError("画布中的单品必须与穿搭所选单品一致。")
        return self


class OutfitInput(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    item_ids: list[str] = Field(min_length=1, max_length=24)
    notes: str = Field(default="", max_length=3000)
    source: Literal["manual", "rules", "ai", "assistant"] = "manual"
    layout: OutfitLayout | None = None

    @model_validator(mode="after")
    def valid_layout(self):
        if self.layout is not None:
            self.layout.check_items(self.item_ids)
        return self


class WearInput(StrictModel):
    item_ids: list[str] = Field(min_length=1, max_length=24)
    date: date
    notes: str = Field(default="", max_length=3000)
    request_id: str = Field(min_length=8, max_length=120)


class PlanInput(StrictModel):
    date: date
    item_ids: list[str] = Field(default_factory=list, max_length=24)
    outfit_id: str | None = None
    name: str = Field(default="今日穿搭", min_length=1, max_length=120)
    notes: str = Field(default="", max_length=3000)


class TripEntry(StrictModel):
    item_id: str
    packed: bool = False


class TripInput(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    destination: str = Field(default="", max_length=120)
    start_date: date
    end_date: date
    entries: list[TripEntry] = Field(default_factory=list, max_length=1000)


class Preferences(StrictModel):
    location: str = Field(default="", max_length=120)
    temperature: float = Field(default=22, ge=-50, le=60)
    sensitivity: Literal["cold", "normal", "hot"] = "normal"
    notes: str = Field(default="", max_length=3000)
    excluded_ids: list[str] = Field(default_factory=list, max_length=1000)
    blocked_pairs: list[list[str]] = Field(default_factory=list, max_length=500)
    closet_scope: str = Field(default="all", max_length=80)


class SettingsPatch(StrictModel):
    name: str = Field(default="", max_length=80)
    onboarded: bool = False
    language: Literal["zh-CN"] = "zh-CN"
    preferences: Preferences | None = None


class RecommendationInput(StrictModel):
    temperature: float = Field(default=22, ge=-50, le=60)
    occasion: Literal["casual", "work", "sport", "formal"] = "casual"
    locked_ids: list[str] = Field(default_factory=list, max_length=12)
    excluded_ids: list[str] = Field(default_factory=list, max_length=1000)
    seed: int = Field(default=0, ge=0, le=2147483647)
