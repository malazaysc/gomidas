// Pins GOM-102: native menu ids are handles from one registry, so a menu-table item can never be
// mistaken for an Open Recent / Clear Recent entry. The old scheme encoded meaning into the id —
// (menu + 1) * 1000 + (item + 1), with Open Recent at "anything >= 9000" — and the 9th menu
// (Sound) reached it, so Sound items opened recent files and View/Window/Help did nothing.
// Build with -DGOMIDAS_BUILD_TESTS=ON, then: ./menu_ids_test
#include "ui/MenuIds.h"
#include <cstdio>
#include <set>
#include <string>

static int failures = 0;

static void check (bool ok, const char* what)
{
    if (! ok) { std::printf ("FAIL: %s\n", what); ++failures; }
}

struct Cmd { std::string kind, value; };

static bool is (const gomidas::MenuIdRegistry<Cmd>& reg, int id, const char* kind, const char* value)
{
    const Cmd* c = reg.find (id);
    return c != nullptr && c->kind == kind && c->value == value;
}

int main()
{
    gomidas::MenuIdRegistry<Cmd> reg;

    // A table shaped like the real one: 12 menus, the 9th (Sound) with 20 items, one with 1200 —
    // more than the old 1000-per-menu stride could hold.
    std::set<int> tableIds;
    int soundFirst = 0, helpAbout = 0;
    for (int m = 0; m < 12; ++m)
        for (int j = 0; j < (m == 5 ? 1200 : 20); ++j)
        {
            const int id = reg.add ({ "action", "m" + std::to_string (m) + "i" + std::to_string (j) });
            tableIds.insert (id);
            if (m == 8 && j == 0) soundFirst = id;
            if (m == 11 && j == 0) helpAbout = id;
        }
    reg.freeze();
    check (tableIds.size() == 11 * 20 + 1200, "every table item gets its own id");
    check (*tableIds.begin() >= 1, "ids start at 1 (JUCE treats 0 as no item)");

    // Open Recent, built the way getMenuForIndex builds it.
    auto buildRecent = [&] (std::initializer_list<const char*> paths)
    {
        reg.clearDynamic();
        std::set<int> ids;
        for (auto* p : paths) ids.insert (reg.add ({ "openRecent", p }));
        ids.insert (reg.add ({ "clearRecent", "" }));
        return ids;
    };
    auto recent = buildRecent ({ "/a.gp", "/b.gp" });

    bool disjoint = true;
    for (int id : recent) disjoint = disjoint && tableIds.count (id) == 0;
    check (disjoint, "no Open Recent id equals a table id");

    check (is (reg, soundFirst, "action", "m8i0"), "Sound item 1 runs its own action");
    check (is (reg, helpAbout, "action", "m11i0"), "Help item 1 runs its own action");
    check (is (reg, *recent.begin(), "openRecent", "/a.gp"), "a recent id carries the path it showed");
    check (is (reg, *recent.rbegin(), "clearRecent", ""), "Clear Recent resolves to clearRecent");
    const int firstRecent = *recent.begin();

    // Rebuilding the recent submenu leaves the table alone and never grows without bound.
    recent = buildRecent ({ "/c.gp" });
    check (is (reg, soundFirst, "action", "m8i0"), "rebuilding Open Recent keeps table ids");
    check (*recent.begin() == firstRecent, "a rebuild reuses the dynamic ids instead of growing");
    check (is (reg, firstRecent, "openRecent", "/c.gp"), "the rebuilt entry carries the new path");
    check (reg.find (*recent.rbegin() + 1) == nullptr, "ids from the older, longer list are gone");

    check (reg.find (0) == nullptr && reg.find (-1) == nullptr, "0 and negative ids resolve to nothing");

    if (failures == 0) std::printf ("menu_ids_test: all checks passed\n");
    return failures == 0 ? 0 : 1;
}
