from copy import deepcopy

from fastapi import HTTPException
import pytest

from server.models import ItemInput, RecommendationInput
from server.recommendations import recommend, validate_outfit
from server.store import initial_state


def garment(item_id, category, name=None, **changes):
    value = ItemInput(
        name=name or item_id,
        category=category,
        confirmed=True,
        **changes,
    ).model_dump(mode="json")
    return {"id": item_id, **value}


def wardrobe(*extras, dress=False):
    state = initial_state()
    state["items"] = (
        [garment("dress", "dress", "连衣裙")]
        if dress
        else [garment("top", "top", "白衬衫"), garment("bottom", "bottom", "长裤")]
    ) + [garment("shoes", "shoes", "平底鞋"), *extras]
    return state


def choices(state, **changes):
    request = RecommendationInput(**changes).model_dump(mode="json")
    result = recommend(state, request)
    for outfit in result["outfits"]:
        validate_outfit(state, outfit["item_ids"], request)
    return [set(outfit["item_ids"]) for outfit in result["outfits"]]


@pytest.mark.parametrize("dress", [False, True], ids=["separates", "dress"])
def test_adds_a_bag_and_accessory_without_losing_an_unadorned_complete_choice(dress):
    state = wardrobe(
        garment("bag", "bag", "通勤手提包"),
        garment("watch", "accessory", "银色手表"),
        dress=dress,
    )
    original = deepcopy(state)
    base = {"dress", "shoes"} if dress else {"top", "bottom", "shoes"}

    result = choices(state)

    assert base in result
    assert any({"bag", "watch"}.issubset(ids) for ids in result)
    assert all(base.issubset(ids) for ids in result)
    assert state == original


def test_automatic_choices_keep_bag_and_accessory_counts_small():
    bags = {f"bag-{index}" for index in range(3)}
    accessories = {"watch", "necklace", "belt", "ring"}
    state = wardrobe(
        *(garment(item_id, "bag", "手提包") for item_id in sorted(bags)),
        garment("watch", "accessory", "手表"),
        garment("necklace", "accessory", "项链"),
        garment("belt", "accessory", "腰带"),
        garment("ring", "accessory", "戒指"),
    )

    result = choices(state)

    assert any(ids & accessories for ids in result)
    assert all(len(ids & bags) <= 1 and len(ids & accessories) <= 2 for ids in result)
    assert {"top", "bottom", "shoes"} in result


@pytest.mark.parametrize(
    ("first_name", "first_tags", "second_name", "second_tags"),
    [
        ("棒球帽", [], "渔夫帽", []),
        ("羊毛围巾", [], "针织围巾", []),
        ("皮革腰带", [], "编织腰带", []),
        ("银色手表", [], "黑色配饰", ["手表"]),
        ("珍珠项链", [], "金色项链", []),
        ("银色耳环", [], "珍珠耳钉", []),
        ("编织手链", [], "金色手镯", []),
        ("银色戒指", [], "金色配饰", ["戒指"]),
        ("蓝色配饰", [], "白色配饰", []),
    ],
    ids=["hat", "scarf", "belt", "watch-tag", "necklace", "earrings", "bracelet", "ring-tag", "unknown"],
)
def test_does_not_stack_two_accessories_of_the_same_kind(first_name, first_tags, second_name, second_tags):
    state = wardrobe(
        garment("first", "accessory", first_name, tags=first_tags),
        garment("second", "accessory", second_name, tags=second_tags),
    )

    result = choices(state, temperature=8)

    assert any(ids & {"first", "second"} for ids in result)
    assert all(len(ids & {"first", "second"}) <= 1 for ids in result)


@pytest.mark.parametrize("temperature", [22, 30])
@pytest.mark.parametrize("name", ["羊毛围巾", "保暖针织帽", "冬季手套"])
def test_warm_weather_does_not_add_cold_weather_accessories(temperature, name):
    state = wardrobe(garment("warm-accessory", "accessory", name))

    result = choices(state, temperature=temperature)

    assert result
    assert all("warm-accessory" not in ids for ids in result)
    assert {"top", "bottom", "shoes"} in result


def test_silk_scarves_can_be_suggested_in_warm_weather():
    state = wardrobe(garment("silk-scarf", "accessory", "真丝丝巾", seasons=["summer"]))

    result = choices(state, temperature=28)

    assert any("silk-scarf" in ids for ids in result)


def test_bags_and_watches_remain_options_in_winter():
    state = wardrobe(
        garment("bag", "bag", "通勤包"),
        garment("watch", "accessory", "手表"),
    )

    result = choices(state, temperature=0)

    assert any({"bag", "watch"}.issubset(ids) for ids in result)


@pytest.mark.parametrize(
    ("category", "name", "changes", "request_options"),
    [
        ("bag", "手提包", {"seasons": ["winter"]}, {"temperature": 28}),
        ("accessory", "项链", {"occasions": ["formal"]}, {"occasion": "sport"}),
        ("bag", "晚宴包", {"occasions": ["formal"]}, {"occasion": "work"}),
    ],
    ids=["season", "accessory-occasion", "bag-occasion"],
)
def test_explicitly_incompatible_extras_leave_a_valid_base_choice(category, name, changes, request_options):
    state = wardrobe(garment("incompatible", category, name, **changes))

    result = choices(state, **request_options)

    assert result
    assert all("incompatible" not in ids for ids in result)
    assert {"top", "bottom", "shoes"} in result


def test_automatic_extras_obey_status_scope_and_both_exclusion_sources():
    unconfirmed = garment("unconfirmed", "accessory", "项链")
    unconfirmed["confirmed"] = False
    state = wardrobe(
        unconfirmed,
        garment("laundry", "accessory", "围巾", status="laundry"),
        garment("archived", "bag", "手提包", status="archived"),
        garment("other-closet", "bag", "旅行包", closet="旅行衣橱"),
        garment("preference-excluded", "accessory", "手表"),
        garment("request-excluded", "accessory", "戒指"),
        garment("available-bag", "bag", "通勤包"),
    )
    state["settings"]["preferences"].update(closet_scope="日常衣橱", excluded_ids=["preference-excluded"])
    forbidden = {
        "unconfirmed",
        "laundry",
        "archived",
        "other-closet",
        "preference-excluded",
        "request-excluded",
    }

    result = choices(state, excluded_ids=["request-excluded"])

    assert any("available-bag" in ids for ids in result)
    assert all(not ids & forbidden for ids in result)


def test_blocked_pairs_apply_between_extras_and_to_the_base():
    state = wardrobe(
        garment("blocked-bag", "bag", "通勤包"),
        garment("watch", "accessory", "手表"),
        garment("necklace", "accessory", "项链"),
    )
    state["settings"]["preferences"]["blocked_pairs"] = [
        ["top", "blocked-bag"],
        ["watch", "necklace"],
    ]

    result = choices(state)

    assert any(ids & {"watch", "necklace"} for ids in result)
    assert all("blocked-bag" not in ids and not {"watch", "necklace"}.issubset(ids) for ids in result)
    assert {"top", "bottom", "shoes"} in result


def test_locked_accessories_survive_soft_weather_season_and_occasion_preferences():
    state = wardrobe(
        garment("scarf", "accessory", "羊毛围巾", seasons=["winter"], occasions=["casual"]),
        garment("bag", "bag", "手提包"),
    )

    result = choices(state, temperature=30, occasion="formal", locked_ids=["scarf"])

    assert result and all("scarf" in ids for ids in result)
    assert {"top", "bottom", "shoes", "scarf"} in result
    assert any("bag" in ids for ids in result)


def test_locked_kind_is_not_repeated_but_different_accessory_can_be_added():
    state = wardrobe(
        garment("locked-watch", "accessory", "手表"),
        garment("another-watch", "accessory", "另一块手表"),
        garment("necklace", "accessory", "项链"),
    )

    result = choices(state, locked_ids=["locked-watch"])

    assert result and all("locked-watch" in ids and "another-watch" not in ids for ids in result)
    assert any("necklace" in ids for ids in result)
    assert {"top", "bottom", "shoes", "locked-watch"} in result


def test_explicitly_locked_duplicates_and_over_limit_extras_are_preserved_without_additions():
    locked = {"watch-1", "watch-2", "watch-3", "bag-1", "bag-2"}
    state = wardrobe(
        *(garment(item_id, "accessory", "手表") for item_id in ("watch-1", "watch-2", "watch-3")),
        *(garment(item_id, "bag", "手提包") for item_id in ("bag-1", "bag-2")),
        garment("extra-bag", "bag", "另一个包"),
        garment("extra-necklace", "accessory", "项链"),
    )

    result = choices(state, locked_ids=sorted(locked))

    assert result
    assert all(ids == {"top", "bottom", "shoes"} | locked for ids in result)


@pytest.mark.parametrize("restriction", ["unconfirmed", "laundry", "archived", "excluded", "scope"])
def test_locking_an_accessory_does_not_bypass_hard_eligibility(restriction):
    accessory = garment("watch", "accessory", "手表")
    state = wardrobe(accessory)
    if restriction == "unconfirmed":
        accessory["confirmed"] = False
    elif restriction in {"laundry", "archived"}:
        accessory["status"] = restriction
    elif restriction == "excluded":
        state["settings"]["preferences"]["excluded_ids"] = ["watch"]
    else:
        accessory["closet"] = "旅行衣橱"
        state["settings"]["preferences"]["closet_scope"] = "日常衣橱"

    with pytest.raises(HTTPException) as error:
        choices(state, locked_ids=["watch"])

    assert error.value.status_code == 409


def test_locked_accessory_cannot_override_a_blocked_combination():
    state = wardrobe(garment("watch", "accessory", "手表"))
    state["settings"]["preferences"]["blocked_pairs"] = [["top", "watch"]]

    assert choices(state, locked_ids=["watch"]) == []


def test_accessories_cannot_fill_a_missing_core_category():
    state = wardrobe(garment("bag", "bag", "手提包"), garment("watch", "accessory", "手表"))
    state["items"] = [item for item in state["items"] if item["category"] != "bottom"]

    result = recommend(state, RecommendationInput().model_dump(mode="json"))

    assert result["outfits"] == []
    assert "bottom" in result["missing"]
