"""Render the bundled systemd unit for this checkout without shell expansion."""
from pathlib import Path
import sys


def render_service(project, template):
    project = str(Path(project).resolve())
    if (any(ord(char) < 32 for char in project) or project != project.rstrip()
            or any(char in project for char in '\\"\'$%')):
        raise ValueError("项目路径不能包含控制字符、引号、反斜杠、$、% 或末尾空格。")
    values = {
        "WorkingDirectory": project,
        "ExecStart": (f'"{project}/.venv/bin/python" "{project}/server.py" '
                      f'--host 0.0.0.0 --port 8080 --runtime-dir "{project}/runtime"'),
        "ReadWritePaths": f'"{project}/runtime"',
    }
    found = set()
    lines = []
    for line in template.splitlines():
        key = line.partition("=")[0]
        if key in values:
            if key in found:
                raise ValueError(f"服务模板包含重复的 {key}")
            line = f"{key}={values[key]}"
            found.add(key)
        lines.append(line)
    if found != set(values):
        raise ValueError("服务模板缺少目录或启动命令配置。")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    try:
        project = Path(sys.argv[1])
        print(render_service(project, (project / "deployment/kpl-insight.service").read_text()), end="")
    except (IndexError, ValueError, OSError) as error:
        print(f"无法生成服务配置：{error}", file=sys.stderr)
        raise SystemExit(1)
