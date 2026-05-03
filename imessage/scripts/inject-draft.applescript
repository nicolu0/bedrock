on run argv
	if (count of argv) < 2 then error "Expected chatGuid and draft text"
	-- chatGuid (argv 1) kept for compatibility; navigation is manual — keep Messages open to the group chat
	set draftText to item 2 of argv

	set the clipboard to draftText

	tell application "Messages"
		activate
	end tell

	delay 0.7

	tell application "System Events"
		tell process "Messages"
			set frontmost to true
			delay 0.3
			try
				set inputArea to text area 1 of scroll area 2 of splitter group 1 of window 1
				click inputArea
			on error
				try
					set inputArea to text area 1 of group 2 of splitter group 1 of window 1
					click inputArea
				end try
			end try
			delay 0.2
			keystroke "a" using command down
			delay 0.1
			keystroke "v" using command down
		end tell
	end tell
end run
