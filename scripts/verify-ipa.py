"""Validate the unsigned self-hosted artifact without Apple signing credentials."""
import hashlib
import plistlib
import sys
import zipfile
from pathlib import Path

ipa = Path(sys.argv[1])
with zipfile.ZipFile(ipa) as archive:
    names = set(archive.namelist())
    apps = [name for name in names if name.startswith("Payload/") and name.count("/") == 2 and name.endswith(".app/Info.plist")]
    assert len(apps) == 1, f"Expected one main app, found {apps}"
    main = plistlib.loads(archive.read(apps[0]))
    assert main["CFBundleIdentifier"] == "io.github.hchris233.remodex", main["CFBundleIdentifier"]
    assert main["MinimumOSVersion"] == "18.6", main["MinimumOSVersion"]
    assert not main.get("PHODEX_DEFAULT_RELAY_URL", "").strip(), "A relay hostname must not be baked in"
    assert "remote-notification" not in main.get("UIBackgroundModes", [])
    assert not any("REVENUECAT" in key for key in main)
    assert not any("RevenueCat" in name for name in names)
    extensions = sorted(name for name in names if ".appex/" in name and name.endswith(".appex/Info.plist"))
    assert len(extensions) == 1, extensions
    for info_path in [apps[0], *extensions]:
        info = plistlib.loads(archive.read(info_path))
        assert info["CFBundleIdentifier"] == main["CFBundleIdentifier"] or info["CFBundleIdentifier"].startswith(main["CFBundleIdentifier"] + ".")
        executable = str(Path(info_path).parent / info["CFBundleExecutable"]).replace("\\", "/")
        assert executable in names, f"Missing executable: {executable}"
        assert archive.getinfo(executable).file_size > 0
        assert "iPhoneOS" in info.get("CFBundleSupportedPlatforms", [])
        assert tuple(map(int, info["MinimumOSVersion"].split("."))) <= (18, 6)
        print(f"Verified {info['CFBundleIdentifier']} (iOS {info['MinimumOSVersion']})")

digest = hashlib.sha256(ipa.read_bytes()).hexdigest()
ipa.with_suffix(".ipa.sha256").write_text(f"{digest}  {ipa.name}\n", encoding="utf-8")
print(f"SHA-256: {digest}")
