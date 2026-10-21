// Pins the GOM-90 rule: on WebKitGTK every UTF-8 text asset is served with exactly one BOM,
// binary assets never get one, and nothing changes when the BOM is not requested (macOS).
// Build with -DGOMIDAS_BUILD_TESTS=ON, then: ./asset_bytes_test
#include "ui/AssetBytes.h"
#include <cstdio>
#include <string>

static int failures = 0;

static void check (bool ok, const char* what)
{
    if (! ok) { std::printf ("FAIL: %s\n", what); ++failures; }
}

static std::string str (const std::vector<std::byte>& v)
{
    return std::string (reinterpret_cast<const char*> (v.data()), v.size());
}

int main()
{
    const std::string bom = "\xEF\xBB\xBF";
    const std::string html = "<p>New\xE2\x80\xA6</p>";   // "New…" in UTF-8

    check (str (gomidas::assetBytes (html.data(), html.size(), "text/html", true)) == bom + html,
           "text/html gets a BOM");
    check (str (gomidas::assetBytes (html.data(), html.size(), "text/javascript", true)) == bom + html,
           "text/javascript gets a BOM");
    check (str (gomidas::assetBytes (html.data(), html.size(), "application/json", true)) == bom + html,
           "application/json gets a BOM");
    check (str (gomidas::assetBytes (html.data(), html.size(), "image/svg+xml", true)) == bom + html,
           "image/svg+xml gets a BOM");
    check (str (gomidas::assetBytes (html.data(), html.size(), "application/manifest+json", true)) == bom + html,
           "+json gets a BOM");
    check (str (gomidas::assetBytes (html.data(), html.size(), "Application/JSON; charset=utf-8", true)) == bom + html,
           "MIME matching ignores case and parameters");

    const std::string utf16 ("\xFF\xFE" "N\0e\0w\0", 8);
    check (str (gomidas::assetBytes (utf16.data(), utf16.size(), "text/plain", true)) == utf16,
           "a UTF-16 asset keeps its own BOM and gets no UTF-8 one");

    const std::string withBom = bom + html;
    check (str (gomidas::assetBytes (withBom.data(), withBom.size(), "text/html", true)) == withBom,
           "an asset that already has a BOM is not given a second one");

    const std::string font ("wOF2\x00\x01\xEF\xBB", 8);   // NULs and high bytes, kept by explicit length
    check (str (gomidas::assetBytes (font.data(), font.size(), "font/woff2", true)) == font,
           "binary assets are untouched");
    check (str (gomidas::assetBytes (font.data(), font.size(), "image/webp", true)) == font,
           "images are untouched");

    check (str (gomidas::assetBytes (html.data(), html.size(), "text/html", false)) == html,
           "no BOM when not requested (macOS path)");
    check (gomidas::assetBytes (nullptr, 0, "text/html", false).empty(),
           "empty asset stays empty");

    if (failures == 0)
        std::printf ("PASS: asset_bytes_test\n");
    return failures == 0 ? 0 : 1;
}
