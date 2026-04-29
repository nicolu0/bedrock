on run argv
  if (count of argv) < 1 then return
  set chatURL to item 1 of argv
  set durationSeconds to 3
  if (count of argv) >= 2 then
    try
      set durationSeconds to (item 2 of argv) as integer
    end try
  end if
  if durationSeconds < 1 then set durationSeconds to 1

  tell application "Messages" to activate
  delay 0.2
  open location chatURL
  delay 0.9

  tell application "System Events"
    tell process "Messages"
      set frontmost to true
      if (count of windows) > 0 then
        set targetWindow to front window
        try
          set allAreas to every text area of targetWindow
          if (count of allAreas) > 0 then
            set focused of item (count of allAreas) of allAreas to true
          end if
        end try
      end if
    end tell
  end tell
  delay 0.15

  set typedCount to 0
  set endAt to (current date) + durationSeconds
  repeat while (current date) is less than endAt
    tell application "System Events"
      tell process "Messages"
        keystroke "."
      end tell
    end tell
    set typedCount to typedCount + 1
    delay 0.35
  end repeat

  repeat typedCount times
    tell application "System Events"
      tell process "Messages"
        key code 51
      end tell
    end tell
    delay 0.03
  end repeat

  return "typed_count=" & typedCount
end run
