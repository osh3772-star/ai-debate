"""Bundle local browser sources. Does not start the server or invoke any model."""
from pathlib import Path

WEB = Path(__file__).resolve().parent / "web"


def build():
    for output, sources in {
        "app.js": ("summary.js", "controller.js"),
        "style.css": ("base.css", "summary.css"),
    }.items():
        content = "\n\n".join((WEB / source).read_text(encoding="utf-8-sig") for source in sources)
        (WEB / output).write_text(content + "\n", encoding="utf-8")
        print(f"{output}: {', '.join(sources)}")


if __name__ == "__main__":
    build()
