#pragma once
// Item ids for the native (macOS) menu bar (GOM-102). Header-only and JUCE-free so
// tests/menu_ids_test.cpp can pin it without the GUI.
//
// Ids used to encode meaning: table item j of menu i was (i + 1) * 1000 + (j + 1), and Open Recent
// lived at "anything >= 9000" — which the 9th menu (Sound) reached, so Sound items opened recent
// files and View/Window/Help items did nothing. Now every id is just a handle handed out in order,
// and what it means is stored next to it, so two kinds of item cannot share an id.
//
// The menu table is registered once and stays fixed. The dynamic tail (Open Recent) is rebuilt
// each time its menu is built — JUCE rebuilds a macOS top-level menu on every open (menuNeedsUpdate
// → getMenuForIndex), so the menu on screen always matches the latest registration.
#include <cstddef>
#include <utility>
#include <vector>

namespace gomidas
{
    template <typename Payload>
    class MenuIdRegistry
    {
    public:
        /** Registers a payload and returns its id (1-based: JUCE treats id 0 as "no item"). */
        int add (Payload p)
        {
            items.push_back (std::move (p));
            return (int) items.size();
        }

        /** The payload registered under id, or nullptr if there is none. */
        const Payload* find (int id) const
        {
            return id >= 1 && id <= (int) items.size() ? &items[(size_t) id - 1] : nullptr;
        }

        /** Everything registered so far stays fixed; later entries are the dynamic tail. */
        void freeze() { fixedCount = items.size(); }

        /** Drops the dynamic tail so it can be registered again; fixed ids are untouched. */
        void clearDynamic() { items.erase (items.begin() + (std::ptrdiff_t) fixedCount, items.end()); }

    private:
        std::vector<Payload> items;
        std::size_t fixedCount = 0;
    };
}
