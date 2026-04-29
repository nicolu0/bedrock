on run argv
  if (count of argv) < 3 then error "Expected chatGuid, handle, and message"
  set targetChatGuid to item 1 of argv
  set targetHandle to item 2 of argv
  set replyText to item 3 of argv

  tell application "Messages"
    if targetChatGuid is not "" then
      try
        set targetChat to chat id targetChatGuid
        send replyText to targetChat
        return
      end try
    end if

    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy targetHandle of targetService
    send replyText to targetBuddy
  end tell
end run
