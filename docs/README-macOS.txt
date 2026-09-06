MewMuze Pro for macOS
=====================

A tiny pixel-art cat that lives on your desktop.


INSTALLING
----------

1. Open MewMuze-Pro.dmg.
2. Drag MewMuze into the Applications folder shown beside it.
3. Eject the disk image and open MewMuze from Applications or Spotlight.

MewMuze has no Dock icon by design — it lives on your desktop, and its
controls are in the menu bar at the top of the screen and in the right-click
menu on the cat itself.

Nothing else is needed. There is no runtime to install.


FIRST LAUNCH
------------

If macOS says the app "cannot be opened because the developer cannot be
verified", this copy is not yet notarised by Apple. Right-click (or
Control-click) MewMuze in Applications, choose Open, and confirm once. macOS
remembers the choice.


PERMISSIONS
-----------

MewMuze asks for as little as possible, and only when you use the feature:

  Screen Recording   Only for Photo Mode's "Desktop + MewMuze" capture. Every
                     other part of the app, including the cat itself and the
                     other two photo modes, works without it. Nothing is ever
                     captured until you tick the warning and press the button.

MewMuze deliberately does NOT request microphone, camera, contacts, calendar,
photo or location access. The cat's reaction to microphone use is read from the
audio device's own state — no audio is ever opened, which is why you will not
see the orange microphone dot for MewMuze.


YOUR PRO LICENCE
----------------

Your activation is stored in the macOS Keychain, not in a file. It survives
updates, restarts and reinstalls, and it is the same licence as the Windows
version — activate once.


WHERE THINGS LIVE
-----------------

  Settings   ~/Library/Application Support/com.spandan.pixelcat/settings.json
  Costumes   ~/Library/Application Support/com.spandan.pixelcat/costumes/
  Licence    login Keychain, service "com.spandan.pixelcat"

To remove MewMuze completely: quit it from the menu bar, drag it from
Applications to the Trash, and delete the Application Support folder above.


REQUIREMENTS
------------

  macOS 10.15 Catalina or newer
  Apple Silicon or Intel


SUPPORT
-------

  https://mewmuze.com
