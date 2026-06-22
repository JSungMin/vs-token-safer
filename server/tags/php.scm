; PHP — canonical tags query (definitions + call references). Capture names follow the tree-sitter
; tags.scm convention: @definition.<kind> on the declaration node, @name on its identifier.
(function_definition name: (name) @name) @definition.function
(method_declaration name: (name) @name) @definition.method
(class_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.interface
(trait_declaration name: (name) @name) @definition.trait
(function_call_expression function: (name) @name) @reference.call
(member_call_expression name: (name) @name) @reference.call
