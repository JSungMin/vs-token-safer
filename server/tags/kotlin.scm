; Kotlin — functions, classes, objects. Names are direct identifier children (no `name` field).
(function_declaration (simple_identifier) @name) @definition.function
(class_declaration (type_identifier) @name) @definition.class
(object_declaration (type_identifier) @name) @definition.object
(call_expression (simple_identifier) @name) @reference.call
