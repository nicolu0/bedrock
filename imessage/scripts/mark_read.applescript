on run argv
  if (count of argv) < 1 then return
  set chatURL to item 1 of argv

  tell application "Messages" to activate
  delay 0.2
  open location chatURL
  delay 0.5

  tell application "System Events"
    tell process "Messages"
      set frontmost to true
    end tell
  end tell

  return "mark_read_opened"
end run
