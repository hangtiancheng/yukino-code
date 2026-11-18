package history

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

func platformFileSignature(path string, info os.FileInfo) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	handle := windows.Handle(file.Fd())
	var identity windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &identity) != nil {
		return ""
	}
	// FILE_BASIC_INFO is a Win32 structure with four 64-bit timestamps and a DWORD.
	var basic struct {
		CreationTime, LastAccessTime, LastWriteTime, ChangeTime int64
		FileAttributes                                          uint32
		Padding                                                 uint32
	}
	if windows.GetFileInformationByHandleEx(handle, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))) != nil {
		return ""
	}
	return fmt.Sprintf("%d:%d:%d:%d:%d:%d", identity.VolumeSerialNumber, identity.FileIndexHigh, identity.FileIndexLow, info.Size(), info.ModTime().UnixNano(), basic.ChangeTime)
}
