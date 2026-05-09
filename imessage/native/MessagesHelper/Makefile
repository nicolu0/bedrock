BUNDLE_NAME := MessagesHelper
BUNDLE := $(BUNDLE_NAME).bundle
DYLIB := $(BUNDLE_NAME).dylib
PLUGINS_DIR := $(HOME)/Library/Application Support/MacEnhance/Plugins

CC := clang
CFLAGS := -fobjc-arc -Wall -Wno-objc-method-access -mmacosx-version-min=11.0 -O2 -arch arm64e
LDFLAGS_BUNDLE := -bundle -framework Foundation -arch arm64e
LDFLAGS_DYLIB := -dynamiclib -framework Foundation -arch arm64e

SRC := MessagesHelper.m
OBJ := $(SRC:.m=.o)
BIN := $(BUNDLE)/Contents/MacOS/$(BUNDLE_NAME)

.PHONY: all bundle dylib install clean

all: bundle dylib

bundle: $(BUNDLE)
dylib: $(DYLIB)

%.o: %.m
	$(CC) $(CFLAGS) -c $< -o $@

$(BUNDLE): $(OBJ) Info.plist
	mkdir -p "$(BUNDLE)/Contents/MacOS"
	$(CC) $(LDFLAGS_BUNDLE) -o "$(BIN)" $(OBJ)
	cp Info.plist "$(BUNDLE)/Contents/Info.plist"
	codesign --force --sign - "$(BUNDLE)"

# Standalone dylib for DYLD_INSERT_LIBRARIES into a re-signed Messages.app copy
$(DYLIB): $(OBJ)
	$(CC) $(LDFLAGS_DYLIB) -install_name @rpath/$(DYLIB) -o $(DYLIB) $(OBJ)
	codesign --force --sign - $(DYLIB)

install: $(BUNDLE)
	mkdir -p "$(PLUGINS_DIR)"
	rm -rf "$(PLUGINS_DIR)/$(BUNDLE)"
	cp -R "$(BUNDLE)" "$(PLUGINS_DIR)/"
	@echo "Installed to: $(PLUGINS_DIR)/$(BUNDLE)"
	@echo "Quit and relaunch Messages.app to load the helper."

clean:
	rm -rf $(OBJ) $(BUNDLE) $(DYLIB)
