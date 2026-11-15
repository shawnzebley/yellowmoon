"""Generate the iPhone bundle's Rust licence texts using the shared project policy."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools/licences"))
from generate import collect_notices, collect_rust, fence  # noqa: E402


def main() -> None:
    target, output = sys.argv[1:]
    config = (REPO / "tools/licences/about.toml").read_text()
    config = config.replace(
        'targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"]',
        f'targets = ["{target}"]',
    )
    with tempfile.TemporaryDirectory() as tmp:
        policy = Path(tmp) / "about.toml"
        policy.write_text(config)
        report = json.loads(subprocess.check_output([
            "cargo-about", "generate", "--format", "json", "--locked", "--fail",
            "--offline", "-c", str(policy), "-m", "crates/ym-mobile/Cargo.toml",
        ], cwd=REPO))
    groups = collect_rust([report])
    if not groups:
        raise RuntimeError("No Rust licence texts were found")
    lines = ["# Yellowmoon for iPhone: third-party licences", ""]
    for group in groups:
        lines += [f"## {group.license_id}", ""]
        lines += [f"- {package.name} {package.version}" for package in group.packages]
        lines += ["", fence(group.text)[0], group.text, fence(group.text)[1], ""]
    for (name, version), notice in sorted(collect_notices([report]).items()):
        lines += [f"## Notice: {name} {version}", "", notice, ""]
    Path(output).write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
