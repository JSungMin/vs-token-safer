; Swift — functions, types, protocols. The function/class name is a direct identifier child (no `name`
; field in this grammar), so it is captured positionally.
(function_declaration (simple_identifier) @name) @definition.function
(class_declaration (type_identifier) @name) @definition.class
(protocol_declaration (type_identifier) @name) @definition.protocol
(call_expression (simple_identifier) @name) @reference.call
