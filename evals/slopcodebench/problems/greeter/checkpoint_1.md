Implement a command-line program in the file `%%%ENTRYPOINT:entry_file%%%`. It
will be run as `%%%ENTRYPOINT:entry_command%%%`.

Behavior:
- Read a single line containing a name from standard input.
- Print exactly `Hello, <name>!` followed by a newline, where `<name>` is the
  input line with surrounding whitespace stripped.
- Exit with status code `0`.

Example: given the stdin `World`, the program prints `Hello, World!`.
