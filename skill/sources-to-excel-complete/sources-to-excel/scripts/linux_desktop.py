"""AT-SPI bridge: observed application/window handles and bounded accessible controls."""
import json
import os
import sys
import subprocess
import pyatspi as a

def windows():
    result = []
    desktop = a.Registry.getDesktop(0)
    for app in desktop:
        try:
            pid = app.get_process_id()
            for index, window in enumerate(app):
                if index >= 999:
                    break
                if window.getState().contains(a.STATE_SHOWING):
                    result.append((pid * 1000 + index + 1, window, pid))
        except Exception:
            continue
    return result

def main(request):
    available = windows()
    describe = lambda h, w, pid: dict(windowHandle=h, title=w.name, processId=pid)
    if request['action'] == 'list_windows':
        return dict(windows=[describe(*item) for item in available], backend='AT-SPI')
    selected = next((item for item in available if item[0] == request.get('windowHandle')), None)
    if selected is None:
        raise ValueError('窗口已变化，请重新列出窗口')
    handle, window, pid = selected
    queue, controls = [(window, '0')], []
    targets = {}
    while queue and len(controls) < 300:
        item, identifier = queue.pop(0)
        state = item.getState()
        # Never expose editable contents or names of password entries.
        protected = item.getRole() == a.ROLE_PASSWORD_TEXT
        targets[identifier] = item
        controls.append(dict(targetId=identifier, name='' if protected else item.name,
                             role=item.getRoleName(), password=protected,
                             enabled=state.contains(a.STATE_ENABLED), showing=state.contains(a.STATE_SHOWING)))
        if not protected:
            for index in range(min(item.childCount, 300-len(controls))):
                queue.append((item[index], identifier+'.'+str(index)))
    if request['action'] == 'inspect':
        return dict(window=describe(*selected), controls=controls, truncated=bool(queue))
    if request['action'] == 'screenshot':
        if os.environ.get('XDG_SESSION_TYPE') == 'wayland':
            raise ValueError('Wayland 截屏须经桌面门户授权；当前桥接只提供 AT-SPI 控件操作，请使用浏览器验证或切换 X11')
        import gi
        gi.require_version('Gdk', '3.0')
        from gi.repository import Gdk
        extent = window.queryComponent().getExtents(a.DESKTOP_COORDS)
        pix = Gdk.pixbuf_get_from_window(Gdk.get_default_root_window(), extent.x, extent.y, extent.width, extent.height)
        if pix is None:
            raise ValueError('当前显示会话无法截屏')
        pix.savev(request['outputPath'], 'png', [], [])
        return dict(path=request['outputPath'], requiresVerification=True)
    if request['action'] == 'hotkey':
        if os.environ.get('XDG_SESSION_TYPE') == 'wayland':
            raise ValueError('Wayland 不允许此 X11 快捷键桥接；请使用已观察控件的 invoke / set_value，或在登录界面选择 X11 会话')
        keys = {'ENTER':'Return', 'TAB':'Tab', 'ESC':'Escape', 'CTRL+S':'ctrl+s',
                'CTRL+A':'ctrl+a', 'CTRL+C':'ctrl+c', 'CTRL+V':'ctrl+v', 'CTRL+Z':'ctrl+z', 'ALT+F4':'alt+F4'}
        key = keys.get(request.get('key'))
        if key is None:
            raise ValueError('不支持的快捷键')
        def xdo(*args):
            return subprocess.run(['xdotool', *args], check=True, capture_output=True, text=True, timeout=5).stdout.strip()
        # Never select an arbitrary window when a process has several top-level windows.
        ids = xdo('search', '--onlyvisible', '--pid', str(pid)).splitlines()
        matches = [wid for wid in ids if xdo('getwindowname', wid) == window.name]
        if len(matches) != 1:
            raise ValueError('无法唯一确定快捷键窗口，请使用具体控件操作')
        wid = matches[0]
        xdo('windowactivate', '--sync', wid)
        if xdo('getactivewindow') != wid:
            raise ValueError('目标窗口未获得焦点')
        # Refuse key injection if a protected password control is focused.
        if any(item.getRole() == a.ROLE_PASSWORD_TEXT and item.getState().contains(a.STATE_FOCUSED) for item in targets.values()):
            raise ValueError('密码控件请由用户操作')
        xdo('key', '--clearmodifiers', key)
        return dict(ok=True, window=describe(*selected), action='hotkey', requiresVerification=True)
    target = targets.get(request.get('targetId'))
    if target is None:
        raise ValueError('控件已变化或不在本次检查范围，请重新 inspect')
    state = target.getState()
    if target.getRole() == a.ROLE_PASSWORD_TEXT:
        raise ValueError('密码请由用户自行输入')
    if not state.contains(a.STATE_ENABLED) or not state.contains(a.STATE_SHOWING):
        raise ValueError('控件不可操作')
    if request['action'] == 'set_value':
        if not state.contains(a.STATE_EDITABLE):
            raise ValueError('控件不可编辑')
        if not target.queryEditableText().setTextContents(request['value']):
            raise ValueError('控件拒绝设置内容')
    elif request['action'] == 'invoke':
        action = target.queryAction()
        if not action.nActions or not action.doAction(0):
            raise ValueError('控件没有可执行动作')
    else:
        raise ValueError('不支持的动作')
    return dict(ok=True, window=describe(*selected), action=request['action'], requiresVerification=True)

if __name__ == '__main__':
    try:
        print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps(dict(ok=False, error=str(error)), ensure_ascii=False))
        sys.exit(1)
