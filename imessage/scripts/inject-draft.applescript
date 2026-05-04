on run argv
	if (count of argv) < 2 then error "Expected chatGuid and draft text"
	-- chatGuid (argv 1) kept for compatibility; navigation is manual — keep Messages open to the group chat
	set draftText to item 2 of argv

	set the clipboard to draftText

	tell application "Messages"
		activate
	end tell

	delay 0.8

	tell application "System Events"
		tell process "Messages"
			set frontmost to true
			delay 0.4

			set inputClicked to false

			-- Path 1: scroll area 2 in splitter group (common on macOS 13-14)
			try
				set inputArea to text area 1 of scroll area 2 of splitter group 1 of window 1
				click inputArea
				set inputClicked to true
			end try

			-- Path 2: group 2 direct child (some macOS versions)
			if not inputClicked then
				try
					set inputArea to text area 1 of group 2 of splitter group 1 of window 1
					click inputArea
					set inputClicked to true
				end try
			end if

			-- Path 3: text area inside scroll area inside group 2 (macOS 15+)
			if not inputClicked then
				try
					set inputArea to text area 1 of scroll area 1 of group 2 of splitter group 1 of window 1
					click inputArea
					set inputClicked to true
				end try
			end if

			-- Path 4: walk all scroll areas in splitter group looking for one with a text area
			if not inputClicked then
				try
					set sg to splitter group 1 of window 1
					repeat with elem in scroll areas of sg
						if (count of text areas of elem) > 0 then
							click (text area 1 of elem)
							set inputClicked to true
							exit repeat
						end if
					end repeat
				end try
			end if

			delay 0.3
			-- Only select-all if we successfully clicked the input (avoids clearing conversation selection)
			if inputClicked then
				keystroke "a" using command down
				delay 0.1
			end if
			-- Always attempt paste — if Messages input was already focused this still works
			keystroke "v" using command down
		end tell
	end tell
end run
