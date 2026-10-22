#pragma once
// Item ids for the native (macOS) menu bar (GOM-102). Header-only and JUCE-free so
// tests/menu_ids_test.cpp can pin it without the GUI.
//
// Table item j of menu i is (i + 1) * kStride + (j + 1). Open Recent lives in its own range far
// above any table id, and each range is matched explicitly. The recent base used to be 9000,
// which the 9th menu (Sound) reached, so Sound items opened recent files and View/Window/Help
// items did nothing.
#include <optional>

namespace gomidas::menuids
{
    inline constexpr int kStride     = 1000;
    inline constexpr int kRecentMax  = 10;
    inline constexpr int kRecentBase = 1'000'000;

    inline constexpr int kNoRecentId    = kRecentBase + kRecentMax + 1;   // disabled placeholder
    inline constexpr int kClearRecentId = kRecentBase + kRecentMax + 2;

    struct TableItem { int menu, item; };

    constexpr int tableId (int menu, int item) { return (menu + 1) * kStride + (item + 1); }

    constexpr std::optional<TableItem> decodeTable (int id)
    {
        if (id <= kStride || id >= kRecentBase || id % kStride == 0)
            return std::nullopt;
        return TableItem { id / kStride - 1, id % kStride - 1 };
    }

    constexpr int recentId (int r) { return kRecentBase + r; }

    constexpr std::optional<int> decodeRecent (int id)
    {
        if (id >= kRecentBase && id < kRecentBase + kRecentMax)
            return id - kRecentBase;
        return std::nullopt;
    }

    /** True if a table of menuCount menus, none longer than maxItems, stays inside the table range. */
    constexpr bool fits (int menuCount, int maxItems)
    {
        return menuCount >= 0 && maxItems >= 0 && maxItems < kStride
            && (menuCount + 1) * kStride <= kRecentBase;
    }

    static_assert (kClearRecentId > kNoRecentId && kNoRecentId >= kRecentBase + kRecentMax);
    static_assert (! decodeRecent (kClearRecentId) && ! decodeRecent (kNoRecentId));
    static_assert (! decodeTable (kRecentBase) && ! decodeTable (kClearRecentId));
}
