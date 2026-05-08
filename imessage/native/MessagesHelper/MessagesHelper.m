// MessagesHelper — injected into Messages.app, calls private IMCore.
// IPC model: we are the CLIENT. Messages.app is sandboxed and cannot listen()
// on a socket (network.server entitlement absent), so the Node-side agent runs
// the TCP listener at 127.0.0.1:HELPER_PORT. We connect out (network.client is
// allowed) and stream newline-delimited JSON requests/responses.
//
// Wire format:
//   server -> helper: {"id":<n>, "op":"...", "chatGuid":"..."}\n
//   helper -> server: {"id":<n>, "ok":true|false, "error":"...", ...}\n
//
// On disconnect we reconnect with backoff; the server may not be running yet
// when Messages.app launches.

#import <Foundation/Foundation.h>
#import <os/log.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <arpa/inet.h>
#import <unistd.h>
#import <errno.h>

@class IMChat;
@class IMMessage;

@interface IMMessage : NSObject
- (instancetype)initWithSender:(id)sender
                          time:(id)time
                          text:(NSAttributedString *)text
                messageSubject:(id)messageSubject
             fileTransferGUIDs:(NSArray *)fileTransferGUIDs
                         flags:(uint64_t)flags
                         error:(id)error
                          guid:(NSString *)guid
                       subject:(NSString *)subject
         associatedMessageGUID:(NSString *)associatedMessageGUID
         associatedMessageType:(long long)associatedMessageType
        associatedMessageRange:(NSRange)associatedMessageRange
            messageSummaryInfo:(NSDictionary *)messageSummaryInfo;
@end

@interface IMChat : NSObject
- (NSString *)guid;
- (void)setLocalUserIsTyping:(BOOL)typing;
- (void)markAllMessagesAsRead;
- (void)sendMessage:(IMMessage *)message;
@end

@interface IMChatRegistry : NSObject
+ (instancetype)sharedInstance;
- (IMChat *)existingChatWithGUID:(NSString *)guid;
- (NSArray<IMChat *> *)allExistingChats;
@end

// Tapback codes (from BlueBubbles' parseReactionType, derived from IMCore).
// 2000-2005 add a reaction; 3000-3005 remove the same reaction.
static long long parseReactionType(NSString *t) {
	NSString *s = [t lowercaseString];
	if ([s isEqualToString:@"love"]) return 2000;
	if ([s isEqualToString:@"like"]) return 2001;
	if ([s isEqualToString:@"dislike"]) return 2002;
	if ([s isEqualToString:@"laugh"]) return 2003;
	if ([s isEqualToString:@"emphasize"]) return 2004;
	if ([s isEqualToString:@"question"]) return 2005;
	if ([s isEqualToString:@"-love"]) return 3000;
	if ([s isEqualToString:@"-like"]) return 3001;
	if ([s isEqualToString:@"-dislike"]) return 3002;
	if ([s isEqualToString:@"-laugh"]) return 3003;
	if ([s isEqualToString:@"-emphasize"]) return 3004;
	if ([s isEqualToString:@"-question"]) return 3005;
	return 0;
}

static NSString *reactionVerb(NSString *t) {
	NSString *s = [t lowercaseString];
	if ([s isEqualToString:@"love"]) return @"Loved ";
	if ([s isEqualToString:@"like"]) return @"Liked ";
	if ([s isEqualToString:@"dislike"]) return @"Disliked ";
	if ([s isEqualToString:@"laugh"]) return @"Laughed at ";
	if ([s isEqualToString:@"emphasize"]) return @"Emphasized ";
	if ([s isEqualToString:@"question"]) return @"Questioned ";
	if ([s isEqualToString:@"-love"]) return @"Removed a heart from ";
	if ([s isEqualToString:@"-like"]) return @"Removed a like from ";
	if ([s isEqualToString:@"-dislike"]) return @"Removed a dislike from ";
	if ([s isEqualToString:@"-laugh"]) return @"Removed a laugh from ";
	if ([s isEqualToString:@"-emphasize"]) return @"Removed an exclamation from ";
	if ([s isEqualToString:@"-question"]) return @"Removed a question mark from ";
	return @"";
}

static os_log_t mhlog;
static const uint16_t kHelperPort = 9772;

static IMChat *resolveChat(NSString *guid) {
	if (!guid.length) return nil;
	Class regClass = NSClassFromString(@"IMChatRegistry");
	if (!regClass) {
		os_log_error(mhlog, "IMChatRegistry class not loaded");
		return nil;
	}
	IMChatRegistry *reg = [regClass sharedInstance];
	IMChat *chat = nil;
	@try {
		chat = [reg existingChatWithGUID:guid];
	} @catch (NSException *ex) {
		os_log_error(mhlog, "existingChatWithGUID threw: %{public}@", ex.reason);
	}
	if (chat) return chat;
	@try {
		for (IMChat *c in [reg allExistingChats]) {
			if ([[c guid] isEqualToString:guid]) return c;
		}
	} @catch (NSException *ex) {
		os_log_error(mhlog, "allExistingChats scan threw: %{public}@", ex.reason);
	}
	return nil;
}

// Runs on the main queue. Returns a response NSDictionary keyed by id.
static NSDictionary *handleRequest(NSDictionary *req) {
	NSString *op = req[@"op"];
	NSString *guid = req[@"chatGuid"];
	id reqId = req[@"id"] ?: @0;
	NSMutableDictionary *resp = [NSMutableDictionary dictionary];
	resp[@"id"] = reqId;

	@try {
		if ([op isEqualToString:@"ping"]) {
			resp[@"ok"] = @YES;
			resp[@"pid"] = @(getpid());
			return resp;
		}
		if ([op isEqualToString:@"markRead"]) {
			IMChat *chat = resolveChat(guid);
			if (!chat) { resp[@"ok"] = @NO; resp[@"error"] = @"chat not found"; return resp; }
			[chat markAllMessagesAsRead];
			os_log(mhlog, "markRead %{public}@", guid);
			resp[@"ok"] = @YES;
			return resp;
		}
		if ([op isEqualToString:@"setTyping"]) {
			IMChat *chat = resolveChat(guid);
			if (!chat) { resp[@"ok"] = @NO; resp[@"error"] = @"chat not found"; return resp; }
			BOOL t = [req[@"typing"] boolValue];
			[chat setLocalUserIsTyping:t];
			os_log(mhlog, "setTyping %{public}@ -> %d", guid, t);
			resp[@"ok"] = @YES;
			return resp;
		}
		if ([op isEqualToString:@"react"]) {
			IMChat *chat = resolveChat(guid);
			if (!chat) { resp[@"ok"] = @NO; resp[@"error"] = @"chat not found"; return resp; }

			NSString *targetGuid = req[@"messageGuid"];
			NSString *reactionStr = req[@"reactionType"];
			NSString *summary = req[@"summaryText"] ?: @"";
			if (!targetGuid.length || !reactionStr.length) {
				resp[@"ok"] = @NO; resp[@"error"] = @"missing messageGuid or reactionType"; return resp;
			}

			long long reactionType = parseReactionType(reactionStr);
			if (reactionType == 0) {
				resp[@"ok"] = @NO; resp[@"error"] = @"unknown reactionType"; return resp;
			}

			Class IMMessageClass = NSClassFromString(@"IMMessage");
			if (!IMMessageClass) {
				resp[@"ok"] = @NO; resp[@"error"] = @"IMMessage class not loaded"; return resp;
			}

			// Build the summary string the way iMessage clients without tapback
			// rendering will display it: 'Loved "Hello there"'.
			NSString *summaryStr = [NSString stringWithFormat:@"%@“%@”",
				reactionVerb(reactionStr), summary];
			NSAttributedString *summaryAttr = [[NSAttributedString alloc] initWithString:summaryStr];

			// associatedMessageGUID format: "bp:<targetMessageGUID>" reacts to the
			// whole message bubble. (Multi-part messages would use "p:<idx>/<guid>".)
			NSString *assocGuid = [NSString stringWithFormat:@"bp:%@", targetGuid];

			IMMessage *m = [IMMessageClass alloc];
			m = [m initWithSender:nil
			                 time:nil
			                 text:summaryAttr
			       messageSubject:nil
			    fileTransferGUIDs:nil
			                flags:0x5
			                error:nil
			                 guid:nil
			              subject:nil
			associatedMessageGUID:assocGuid
			associatedMessageType:reactionType
			associatedMessageRange:NSMakeRange(0, summary.length)
			   messageSummaryInfo:@{}];

			[chat sendMessage:m];
			os_log(mhlog, "react %{public}@ -> %{public}@ (%lld)", targetGuid, reactionStr, reactionType);
			resp[@"ok"] = @YES;
			return resp;
		}
		resp[@"ok"] = @NO;
		resp[@"error"] = @"unknown op";
		return resp;
	} @catch (NSException *ex) {
		resp[@"ok"] = @NO;
		resp[@"error"] = ex.reason ?: @"exception";
		return resp;
	}
}

static NSData *encodeResponse(NSDictionary *resp) {
	NSError *err = nil;
	NSData *json = [NSJSONSerialization dataWithJSONObject:resp options:0 error:&err];
	if (!json) {
		json = [@"{\"ok\":false,\"error\":\"encode failed\"}" dataUsingEncoding:NSUTF8StringEncoding];
	}
	NSMutableData *out = [json mutableCopy];
	[out appendBytes:"\n" length:1];
	return out;
}

// Drain one connection: read newline-delimited JSON, hop each request to the
// main queue (IMCore must be touched there), write the response back. Returns
// when the server closes the socket; caller decides whether to reconnect.
static void serveConnection(int fd) {
	NSMutableData *buf = [NSMutableData data];
	uint8_t chunk[4096];
	while (1) {
		ssize_t n = recv(fd, chunk, sizeof(chunk), 0);
		if (n <= 0) break;
		[buf appendBytes:chunk length:(NSUInteger)n];
		while (1) {
			const uint8_t *bytes = buf.bytes;
			NSUInteger len = buf.length;
			NSUInteger nl = NSNotFound;
			for (NSUInteger i = 0; i < len; i++) { if (bytes[i] == '\n') { nl = i; break; } }
			if (nl == NSNotFound) break;
			NSData *line = [buf subdataWithRange:NSMakeRange(0, nl)];
			[buf replaceBytesInRange:NSMakeRange(0, nl + 1) withBytes:NULL length:0];
			if (line.length == 0) continue;

			NSError *err = nil;
			id obj = [NSJSONSerialization JSONObjectWithData:line options:0 error:&err];
			NSData *resp;
			if (![obj isKindOfClass:[NSDictionary class]]) {
				resp = encodeResponse(@{@"ok": @NO, @"error": @"bad json"});
			} else {
				__block NSDictionary *r = nil;
				dispatch_sync(dispatch_get_main_queue(), ^{
					r = handleRequest((NSDictionary *)obj);
				});
				resp = encodeResponse(r);
			}
			ssize_t off = 0;
			while (off < (ssize_t)resp.length) {
				ssize_t w = send(fd, (const uint8_t *)resp.bytes + off, resp.length - off, 0);
				if (w <= 0) { off = -1; break; }
				off += w;
			}
			if (off < 0) { close(fd); return; }
		}
	}
	close(fd);
}

static int connectToServer(void) {
	int s = socket(AF_INET, SOCK_STREAM, 0);
	if (s < 0) return -1;
	struct sockaddr_in addr = {0};
	addr.sin_family = AF_INET;
	addr.sin_port = htons(kHelperPort);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		close(s);
		return -1;
	}
	int yes = 1;
	setsockopt(s, IPPROTO_TCP, 1 /*TCP_NODELAY*/, &yes, sizeof(yes));
	return s;
}

static void runConnectLoop(void) {
	useconds_t backoff = 500 * 1000; // 500ms
	const useconds_t maxBackoff = 5 * 1000 * 1000; // 5s
	while (1) {
		int fd = connectToServer();
		if (fd < 0) {
			usleep(backoff);
			if (backoff < maxBackoff) backoff *= 2;
			continue;
		}
		os_log(mhlog, "connected to agent on 127.0.0.1:%d (pid=%d)", kHelperPort, getpid());
		backoff = 500 * 1000;
		serveConnection(fd);
		os_log(mhlog, "agent disconnected, will reconnect");
	}
}

@interface MessagesHelper : NSObject
@end

@implementation MessagesHelper
+ (void)load {
	mhlog = os_log_create("com.bedrock.MessagesHelper", "main");
	os_log(mhlog, "MessagesHelper +load (pid=%d)", getpid());
	dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
		runConnectLoop();
	});
}
@end
