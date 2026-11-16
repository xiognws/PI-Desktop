# 本地补丁：python-can 的 zlg 后端

这个目录里的东西**不是** pip 装的，重装 `python-can` 会覆盖它们，所以在这里留一份。

## 是什么

`C:\Python3119\Lib\site-packages\can` 里带了一个本机定制的 **周立功（ZLG）USBCAN 后端**：

```
can/interfaces/zlg/
├── __init__.py     导出 ZlgUsbCanBus
├── canlib.py       can.BusABC 实现（zlg 后端本体，约 15 KB）
├── zlgcan.py       zlgcan.dll 的 ctypes 封装
└── dll/
    ├── x64/  zlgcan.dll + kerneldlls\*（x64 驱动）
    └── x86/  zlgcan.dll + kerneldlls\*（x86 驱动）
```

以及 `can/interfaces/__init__.py` 里两行注册：

```python
__all__ = [..., "zlg"]
BACKENDS = {..., "zlg": ("can.interfaces.zlg", "ZlgUsbCanBus")}
```

用法：`can.Bus(interface="zlg", channel=0, dev_type=4)`（`dev_type=4` 即 `ZCAN_USBCAN2`）。

## 重装 python-can 之后怎么恢复

```powershell
$site = "D:\PiWorkspace\python-site"
Copy-Item "$site\.local-patches\python-can-zlg" "$site\can\interfaces\zlg" -Recurse -Force
# 再把 .local-patches\python-can-interfaces-init.py 覆盖到 $site\can\interfaces\__init__.py
```

（`can/interfaces/__init__.py` 的完整副本放在 `python-can-interfaces-init.py`，它已包含 zlg 注册。）

## 验证

```powershell
$py = "D:\Code\PI-Desktop-main\apps\desktop\release\win-unpacked\resources\python\runtime\python.exe"
$env:PYTHONPATH = "D:\PiWorkspace\python-site"
& $py -c "import can; print('zlg' in can.interfaces.VALID_INTERFACES); can.Bus(interface='zlg', channel=0, dev_type=4)"
```

没有插硬件时报 `CanInitializationError: fail to get device handle, device type 4` 属于**正常**——说明 `zlgcan.dll` 已加载、驱动已被调用。
