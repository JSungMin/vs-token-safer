; Dart — top-level functions and methods (both are function_signature) + classes. Methods are captured as
; functions (kind precision is secondary in the syntactic tier); avoids a method/function double-capture.
(function_signature name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class
