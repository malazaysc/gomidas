// Pins the GOM-102 rule: no native menu-table id can be mistaken for an Open Recent / Clear
// Recent id, however many menus the table has. The 9000 base this replaced was reached by the
// 9th menu (Sound), so its items opened recent files and View/Window/Help did nothing.
// Build with -DGOMIDAS_BUILD_TESTS=ON, then: ./menu_ids_test
#include "ui/MenuIds.h"
#include <cstdio>

static int failures = 0;

static void check (bool ok, const char* what)
{
    if (! ok) { std::printf ("FAIL: %s\n", what); ++failures; }
}

int main()
{
    namespace ids = gomidas::menuids;

    // A table a bit larger than today's (12 menus, longest 44 items).
    const int menus = 12, items = 50;
    check (ids::fits (menus, items), "a 12 x 50 table fits");

    bool roundTrips = true, noRecent = true, noClear = true;
    for (int m = 0; m < menus; ++m)
        for (int j = 0; j < items; ++j)
        {
            const int id = ids::tableId (m, j);
            const auto t = ids::decodeTable (id);
            roundTrips = roundTrips && t && t->menu == m && t->item == j;
            noRecent = noRecent && ! ids::decodeRecent (id);
            noClear = noClear && id != ids::kClearRecentId && id != ids::kNoRecentId;
        }
    check (roundTrips, "every table id decodes back to its (menu, item)");
    check (noRecent, "no table id decodes as a recent file");
    check (noClear, "no table id is Clear Recent or the placeholder");

    // The ids the old base collided with: Sound item 1 and item 12.
    check (ids::tableId (8, 0) == 9001 && ! ids::decodeRecent (9001), "Sound item 1 is not a recent file");
    check (ids::tableId (8, 11) == 9012 && 9012 != ids::kClearRecentId, "Sound item 12 is not Clear Recent");
    check (ids::decodeTable (ids::tableId (11, 0)).has_value(), "Help item 1 decodes as a table item");

    bool recentRoundTrips = true;
    for (int r = 0; r < ids::kRecentMax; ++r)
    {
        const auto d = ids::decodeRecent (ids::recentId (r));
        recentRoundTrips = recentRoundTrips && d && *d == r && ! ids::decodeTable (ids::recentId (r));
    }
    check (recentRoundTrips, "recent ids round-trip and never decode as table items");
    check (! ids::decodeRecent (ids::kClearRecentId), "Clear Recent is not a recent entry");
    check (! ids::decodeRecent (ids::kNoRecentId), "the placeholder is not a recent entry");
    check (! ids::decodeRecent (ids::recentId (ids::kRecentMax)), "the recent range ends at kRecentMax");

    check (! ids::decodeTable (0) && ! ids::decodeTable (1000) && ! ids::decodeTable (2000),
           "ids that no table item has do not decode");
    check (! ids::fits (menus, 1000), "a menu of 1000 items would overflow the stride");
    check (! ids::fits (ids::kRecentBase / ids::kStride, 1), "a table reaching the recent base does not fit");

    if (failures == 0) std::printf ("menu_ids_test: all checks passed\n");
    return failures == 0 ? 0 : 1;
}
