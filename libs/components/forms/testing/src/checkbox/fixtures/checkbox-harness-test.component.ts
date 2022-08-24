import { Component, OnInit } from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  Validators,
} from '@angular/forms';

@Component({
  selector: 'test-checkbox-harness',
  templateUrl: './checkbox-harness-test.component.html',
})
export class CheckboxHarnessTestComponent implements OnInit {
  public myForm: FormGroup | undefined;

  #formBuilder: FormBuilder;

  constructor(formBuilder: FormBuilder) {
    this.#formBuilder = formBuilder;
  }

  public ngOnInit(): void {
    this.myForm = this.#formBuilder.group({
      email: new FormControl(false),
      phone: new FormControl(false, [Validators.required]),
    });
  }

  public disableForm(): void {
    this.myForm.disable();
  }
}