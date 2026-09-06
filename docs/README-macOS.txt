MewMuze for macOS
=================

A tiny pixel-art cat that lives on your desktop. Fully local — no account,
no tracking, and nothing leaves your Mac unless you connect Gmail or
Calendar yourself.

Requires macOS 10.15 (Catalina) or later. Runs natively on both Apple
Silicon and Intel Macs.


INSTALL
-------
1. Open MewMuze-macOS.dmg
2. Drag MewMuze onto the Applications folder shown beside it.
3. Eject the disk image and launch MewMuze from Applications.

MewMuze has no Dock icon by design — it is a menu-bar app, so the cat can
live on your desktop without taking a Dock slot. Look for the cat icon in
the menu bar at the top-right of your screen.

If macOS says the app "cannot be opened because the developer cannot be
verified", this build is not yet notarised. Right-click (or Control-click)
MewMuze in Applications, choose Open, then confirm. You only do this once.


PERMISSIONS
-----------
MewMuze asks for as little as possible and keeps working if you decline.

  Not requested at all:
    Microphone, Camera, Contacts, Calendars, Photos, Location, and
    Screen Recording.

  The cat detects that *some* app is using the microphone by reading the
  audio device's on/off state — it never opens the microphone, so macOS
  never shows the orange recording dot for MewMuze.

  Accessibility (optional, only if you want it):
    Not required. Granting it would let the cat tell which DIRECTION you
    are scrolling. Without it the cat still reacts to scrolling, it just
    can't tell up from down. Nothing else changes.


USING IT
--------
- Right-click the cat        : menu (Settings, Work Mode, Focus, and more)
- Left-click and drag        : pick the cat up; it stretches like mochi
- Hover and move the pointer : pet it
- Drop it at a screen edge   : it peeks in from the side
- Click the menu-bar icon    : same menu, plus Cat On/Off and Quit


UPGRADING
---------
Drag the new MewMuze onto Applications and choose Replace. Your settings,
position, costumes and licence key are preserved — they live in your
Library folder, not inside the app.


UNINSTALL
---------
1. Quit MewMuze from the menu-bar icon.
2. Drag /Applications/MewMuze.app to the Trash.

That is a complete uninstall. To also remove your saved settings and
costumes, delete these two folders:

  ~/Library/Application Support/com.spandan.pixelcat
  ~/Library/Preferences/com.spandan.pixelcat.plist

If you enabled "Start with login", removing the app also removes its login
item; you can confirm under System Settings > General > Login Items.


PRIVACY
-------
MewMuze reads only aggregate signals to decide which animation to play:
how recently you typed (never what), whether some app is using the
microphone (never the audio), and the name of the foreground app (never
window titles or documents). Clipboard text stays on your Mac and is never
written to disk.


TROUBLESHOOTING
---------------
Cat not visible?       Menu-bar icon > Cat On, or > Reset cat position.
Cat in the way?        Menu-bar icon > Cat Off, or enable Peek in Settings.
Cat on wrong display?  Menu-bar icon > Reset cat position.
No menu-bar icon?      Relaunch from Applications; macOS hides menu-bar
                       items when the bar is full — try widening it by
                       quitting another menu-bar app.
