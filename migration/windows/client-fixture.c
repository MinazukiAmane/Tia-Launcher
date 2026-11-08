#define UNICODE
#include <windows.h>
#include <shellapi.h>
#include <stdlib.h>

__declspec(dllexport) volatile BYTE flags = 0;
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR command, int show) {
  (void)instance; (void)previous; (void)command; (void)show;
  if (flags != 1 || GetConsoleWindow() != NULL) return 5;
  HANDLE file = CreateFileW(L"native-startup-result.txt", GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return 6;
  DWORD written;
  WriteFile(file, "flags=1\n", 8, &written, NULL);
  int count;
  wchar_t **arguments = CommandLineToArgvW(GetCommandLineW(), &count);
  if (!arguments) return 7;
  for (int i = 1; i < count; ++i) {
    int size = WideCharToMultiByte(CP_UTF8, 0, arguments[i], -1, NULL, 0, NULL, NULL);
    char *text = calloc((size_t)size, 1);
    if (!text) return 8;
    WideCharToMultiByte(CP_UTF8, 0, arguments[i], -1, text, size, NULL, NULL);
    WriteFile(file, text, (DWORD)(size - 1), &written, NULL);
    WriteFile(file, "\n", 1, &written, NULL);
    free(text);
  }
  CloseHandle(file);
  LocalFree(arguments);
  Sleep(300);
  return 0;
}
